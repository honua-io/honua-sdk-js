/**
 * OGC API endpoint-layout resolution.
 *
 * The SDK's headline claim is one typed contract against ANY standards
 * server. For OGC API Features / Records that means the client must not
 * assume a fixed path prefix: a Honua Server mounts the facade at
 * `/ogc/features/...`, but pygeoapi, ldproxy, and GeoServer's OGC API each
 * serve the landing page at their own root and advertise their collections
 * and conformance URLs through the landing page's `links` array
 * (OGC API - Common Requirement 5).
 *
 * This module produces an {@link OgcEndpointLayout} — the concrete set of
 * resource paths a Features client addresses:
 *
 *  - {@link honuaFacadeFeaturesLayout} is the fixed facade layout and the
 *    default. It performs no network round-trips, so existing callers see
 *    zero behaviour change.
 *  - {@link resolveOgcEndpointLayout} discovers the layout from the landing
 *    page (`ogc-api` mode) or auto-detects the facade first and falls back
 *    to discovery (`auto` mode).
 *
 * Per OGC API - Features Requirement 17 the items resource is always at
 * `{collections}/{collectionId}/items`, so a single landing-page fetch is
 * enough to derive every per-collection path from the discovered
 * collections URL.
 *
 * @module
 */

import { HonuaCapabilityNotSupportedError } from "./errors.js";
import type { HonuaProtocolTransport } from "./protocol-transport.js";
import type { HonuaOgcLandingResponse, OgcEndpointLayout } from "./types.js";

/** Discovery mode carried on a source locator. */
export type OgcApiLayoutMode = "honua-facade" | "ogc-api" | "auto";

const DEFAULT_FACADE_BASE = "/ogc/features";

function enc(id: string | number): string {
  return encodeURIComponent(String(id));
}

function trimTrailingSlash(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 0x2f) end--;
  return url.slice(0, end);
}

/**
 * The Honua Server facade layout (`/ogc/features/...`). No network access;
 * this is the default fast path and preserves the pre-existing behaviour of
 * every OGC Features caller that points at a Honua Server.
 */
export function honuaFacadeFeaturesLayout(base: string = DEFAULT_FACADE_BASE): OgcEndpointLayout {
  const root = trimTrailingSlash(base) || DEFAULT_FACADE_BASE;
  return {
    mode: "honua-facade",
    landing: () => root,
    conformance: () => `${root}/conformance`,
    collections: () => `${root}/collections`,
    collection: (id) => `${root}/collections/${enc(id)}`,
    queryables: (id) => `${root}/collections/${enc(id)}/queryables`,
    items: (id) => `${root}/collections/${enc(id)}/items`,
    item: (id, featureId) => `${root}/collections/${enc(id)}/items/${enc(featureId)}`,
  };
}

/**
 * A raw OGC API layout built from a discovered (or configured) landing +
 * collections + conformance URL triple. Per-collection paths are templated
 * off the collections URL per OGC API - Features Requirement 17.
 */
export function ogcApiFeaturesLayout(options: {
  landingUrl: string;
  collectionsUrl: string;
  conformanceUrl: string;
}): OgcEndpointLayout {
  const landing = trimTrailingSlash(options.landingUrl);
  const collections = trimTrailingSlash(options.collectionsUrl);
  const conformance = trimTrailingSlash(options.conformanceUrl);
  return {
    mode: "ogc-api",
    // A bare landing path can be empty (the client baseUrl is the landing
    // root); the wire layer still appends the `f=` param, producing
    // `${baseUrl}?f=json`.
    landing: () => landing,
    conformance: () => conformance,
    collections: () => collections,
    collection: (id) => `${collections}/${enc(id)}`,
    queryables: (id) => `${collections}/${enc(id)}/queryables`,
    items: (id) => `${collections}/${enc(id)}/items`,
    item: (id, featureId) => `${collections}/${enc(id)}/items/${enc(featureId)}`,
  };
}

/**
 * Resolve a link href to an absolute URL against a base. Absolute hrefs are
 * returned unchanged; relative hrefs resolve against `${baseUrl}/`.
 */
function absolutize(href: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  try {
    return new URL(href, root).toString();
  } catch {
    return href;
  }
}

/**
 * Find the first link whose `rel` matches one of `rels` (exact or as the
 * final path segment of a full OGC relation URI, e.g.
 * `http://www.opengis.net/def/rel/ogc/1.0/data`).
 */
export function findOgcLink(
  links: ReadonlyArray<{ href?: string; rel?: string }> | undefined,
  ...rels: string[]
): string | undefined {
  if (!links) return undefined;
  const wanted = new Set(rels.map((r) => r.toLowerCase()));
  for (const link of links) {
    if (typeof link.href !== "string" || link.href.length === 0) continue;
    const rel = (link.rel ?? "").toLowerCase();
    if (wanted.has(rel)) return link.href;
    const tail = rel.slice(rel.lastIndexOf("/") + 1);
    if (tail && wanted.has(tail)) return link.href;
  }
  return undefined;
}

/**
 * Discover an OGC API layout from the landing page. The client `baseUrl`
 * IS the landing page root; the collections and conformance URLs are read
 * from the landing `links` (falling back to the mandated relative
 * `collections` / `conformance` sub-paths when a server omits them).
 */
async function discoverOgcApiLayout(transport: HonuaProtocolTransport): Promise<OgcEndpointLayout> {
  const landing = await transport.requestCachedMetadataJson<HonuaOgcLandingResponse>(
    "ogc-features:layout:landing",
    "?f=json",
    {},
  );
  const baseUrl = trimTrailingSlash(transport.baseUrl);
  const links = landing?.links;
  const dataHref = findOgcLink(links, "data");
  const conformanceHref = findOgcLink(links, "conformance");
  const collectionsUrl = dataHref ? absolutize(dataHref, baseUrl) : `${baseUrl}/collections`;
  const conformanceUrl = conformanceHref ? absolutize(conformanceHref, baseUrl) : `${baseUrl}/conformance`;
  return ogcApiFeaturesLayout({ landingUrl: baseUrl, collectionsUrl, conformanceUrl });
}

/**
 * Probe whether the Honua facade landing (`/ogc/features`) exists. Used by
 * `auto` mode: a valid OGC landing document there confirms the facade
 * fast path; anything else falls through to landing-page discovery.
 */
async function facadeLandingLooksValid(transport: HonuaProtocolTransport): Promise<boolean> {
  try {
    const landing = await transport.requestCachedMetadataJson<HonuaOgcLandingResponse>(
      "ogc-features:layout:facade-probe",
      `${DEFAULT_FACADE_BASE}?f=json`,
      {},
    );
    return Array.isArray(landing?.links);
  } catch {
    return false;
  }
}

/**
 * Resolve the endpoint layout for the requested `mode`:
 *
 *  - `honua-facade` (default) — the fixed facade layout, no round-trips.
 *  - `ogc-api` — discover from the landing page at the client baseUrl.
 *  - `auto` — probe the facade landing; use it when valid, otherwise
 *    discover from the root.
 *
 * Discovery failures surface as {@link HonuaCapabilityNotSupportedError}
 * (per the SDK convention of throwing rather than returning empty data).
 */
export async function resolveOgcEndpointLayout(
  transport: HonuaProtocolTransport,
  mode: OgcApiLayoutMode = "honua-facade",
): Promise<OgcEndpointLayout> {
  if (mode === "honua-facade") return honuaFacadeFeaturesLayout();
  if (mode === "auto") {
    if (await facadeLandingLooksValid(transport)) return honuaFacadeFeaturesLayout();
  }
  try {
    return await discoverOgcApiLayout(transport);
  } catch (err) {
    if (err instanceof HonuaCapabilityNotSupportedError) throw err;
    throw new HonuaCapabilityNotSupportedError(
      "query",
      "ogc-features",
      `ogc-api layout discovery failed for ${transport.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
