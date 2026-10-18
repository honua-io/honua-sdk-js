/**
 * STAC API conformance classes this client actually uses.
 *
 * Predicates match the canonical URIs (and the historical `ogcapi-features`
 * fragment aliases) exactly. A fragment class such as Item Search Filter does
 * not count as Item Search itself. The legacy Query extension is recognized
 * here and is not serialized: `StacSearchRequest` has no `query` parameter,
 * and `Source.query` compiles attribute filters to CQL2.
 *
 * @module
 */

import { type HonuaErrorOptions, HonuaSdkError, mergeHonuaErrorContext } from "./error-envelope.js";
import type { StacSearchRequest } from "./types.js";

const STAC_SPEC_ORIGIN = "https://api.stacspec.org";
const ITEM_SEARCH_PATH = "/v1.0.0/item-search";
const ITEM_SEARCH_URI = `${STAC_SPEC_ORIGIN}${ITEM_SEARCH_PATH}`;
const CQL2_CONFORMANCE_URI = "http://www.opengis.net/spec/cql2/1.0/conf/";

/** Canonical conformance URI for each extension this client gates. */
export const STAC_CONFORMANCE_CLASS = Object.freeze({
  core: `${STAC_SPEC_ORIGIN}/v1.0.0/core`,
  "item-search": ITEM_SEARCH_URI,
  filter: `${ITEM_SEARCH_URI}#filter`,
  "cql2-text": `${CQL2_CONFORMANCE_URI}cql2-text`,
  "cql2-json": `${CQL2_CONFORMANCE_URI}cql2-json`,
  sort: `${ITEM_SEARCH_URI}#sort`,
  fields: `${ITEM_SEARCH_URI}#fields`,
  /** Predicate only. This client does not emit the legacy Query extension. */
  query: `${ITEM_SEARCH_URI}#query`,
} as const);

export type StacConformanceKind = keyof typeof STAC_CONFORMANCE_CLASS;

const OGC_FEATURES_PATH = "/v1.0.0/ogcapi-features";
const EXTENSION_FRAGMENT: Partial<Record<StacConformanceKind, string>> = {
  filter: "#filter",
  sort: "#sort",
  fields: "#fields",
  query: "#query",
};

export interface HonuaStacConformanceErrorOptions extends HonuaErrorOptions {
  /**
   * The search used an extension before any `conformsTo` list was read.
   * Distinct from a landing page that was read and does not declare the class.
   */
  readonly unread?: boolean;
}

/**
 * A STAC search asked for an extension the catalog does not declare, or the
 * client was about to emit that extension without having read `conformsTo`.
 *
 * `conformanceClass` is the first missing class. `missing` lists every class
 * the request needed and the catalog did not declare, in requirement order.
 * The registered code stays `core.capability-not-supported`.
 */
export class HonuaStacConformanceError extends HonuaSdkError {
  public readonly conformanceClass: string;
  public readonly missing: readonly string[];
  public readonly unread: boolean;

  public constructor(missing: readonly string[], options: HonuaStacConformanceErrorOptions = {}) {
    const { unread = false, ...rest } = options;
    const conformanceClass = missing[0] ?? STAC_CONFORMANCE_CLASS["item-search"];
    const named = missing.map((uri) => `"${uri}"`).join(", ");
    const message = unread
      ? `STAC search uses conformance class ${named} but the catalog conformsTo list was not read.`
      : `STAC catalog does not declare conformance class ${named}.`;
    super("core.capability-not-supported", message, {
      ...rest,
      context: mergeHonuaErrorContext(rest.context, {
        conformanceClass,
        missing: [...missing],
        unread,
      }),
    });
    this.name = "HonuaStacConformanceError";
    this.conformanceClass = conformanceClass;
    this.missing = Object.freeze([...missing]);
    this.unread = unread;
  }
}

/** Copy string entries from a landing-page `conformsTo` array. Omitted becomes `[]` (read, nothing declared). */
export function normalizeStacConformsTo(value: readonly string[] | undefined): readonly string[] {
  if (!value) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/** True when `conformsTo` contains the canonical class for `kind`. */
export function hasStacConformance(conformsTo: readonly string[] | undefined, kind: StacConformanceKind): boolean {
  if (!conformsTo) return false;
  for (const entry of conformsTo) {
    if (typeof entry === "string" && matchesStacConformance(entry, kind)) return true;
  }
  return false;
}

/**
 * Extension classes a search will put on the wire. Core Item Search parameters
 * (`bbox`, `datetime`, `intersects`, `ids`, `collections`, `limit`, paging)
 * are not gated. An extension property counts as soon as it is set, including
 * an empty `fields` or `sortby`, because POST emits those members as-is.
 * Opaque `nextParams` / `nextBody` continuations are not inspected.
 */
export function stacSearchExtensionRequirements(request: StacSearchRequest): readonly StacConformanceKind[] {
  const usesFilter = request.filter !== undefined || request.filterLang !== undefined;
  const usesSort = request.sortby !== undefined;
  const usesFields = request.fields !== undefined;
  if (!usesFilter && !usesSort && !usesFields) return [];
  const kinds: StacConformanceKind[] = ["item-search"];
  if (usesFilter) {
    kinds.push("filter");
    // STAC Filter defaults to CQL2 Text for GET and CQL2 JSON for POST.
    // https://github.com/stac-api-extensions/filter#get-query-parameters-and-post-json-fields
    // Gate the language the server will actually interpret when it is omitted.
    const language = request.filterLang ?? (request.usePost === true ? "cql2-json" : "cql2-text");
    if (language === "cql2-json") kinds.push("cql2-json");
    else if (language === "cql2-text") kinds.push("cql2-text");
    else kinds.push("cql2-text", "cql2-json");
  }
  if (usesSort) kinds.push("sort");
  if (usesFields) kinds.push("fields");
  return kinds;
}

/**
 * Refuse an extension search that has not been checked against `conformsTo`.
 * `conformsTo === undefined` means the list was never read and fails before
 * any HTTP request. `conformsTo: []` means it was read and the classes are absent.
 */
export function gateStacSearchExtensions(request: StacSearchRequest): void {
  const required = stacSearchExtensionRequirements(request);
  if (required.length === 0) return;
  const missing = required
    .filter((kind) => !hasStacConformance(request.conformsTo, kind))
    .map((kind) => STAC_CONFORMANCE_CLASS[kind]);
  if (missing.length === 0) return;
  throw new HonuaStacConformanceError(missing, { unread: request.conformsTo === undefined });
}

function matchesStacConformance(value: string, kind: StacConformanceKind): boolean {
  if (kind === "cql2-text" || kind === "cql2-json") return matchesCql2(value, kind);
  const uri = stacSpecUri(value);
  if (!uri) return false;
  const path = uri.pathname.replace(/\/+$/, "");
  if (kind === "core" || kind === "item-search") {
    return uri.hash === "" && path === `/v1.0.0/${kind}`;
  }
  const fragment = EXTENSION_FRAGMENT[kind];
  return fragment !== undefined && uri.hash === fragment && (path === ITEM_SEARCH_PATH || path === OGC_FEATURES_PATH);
}

function stacSpecUri(value: string): URL | undefined {
  try {
    const uri = new URL(value);
    if (
      uri.protocol !== "https:" ||
      uri.origin !== STAC_SPEC_ORIGIN ||
      uri.username !== "" ||
      uri.password !== "" ||
      uri.search !== ""
    ) {
      return undefined;
    }
    return uri;
  } catch {
    return undefined;
  }
}

function matchesCql2(value: string, leaf: "cql2-text" | "cql2-json"): boolean {
  try {
    const uri = new URL(value);
    if (uri.protocol !== "http:" && uri.protocol !== "https:") return false;
    if (uri.hostname !== "www.opengis.net" || uri.port !== "") return false;
    if (uri.username !== "" || uri.password !== "" || uri.search !== "" || uri.hash !== "") return false;
    return uri.pathname.replace(/\/+$/, "") === `/spec/cql2/1.0/conf/${leaf}`;
  } catch {
    return false;
  }
}
