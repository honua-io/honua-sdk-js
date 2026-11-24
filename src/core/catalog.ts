/**
 * Public catalog client: the server's access-filtered listing of published
 * services and their layers, read from the `honua-catalog` OGC API Records
 * collection. The server decides visibility per caller; every read goes to
 * the server through the regular request pipeline and nothing is cached.
 *
 * @module
 */

import { buildOgcRecordPath, buildOgcRecordsSearchPath } from "./ogc-records.js";
import type { HonuaProtocolTransport } from "./protocol-transport.js";
import type { HonuaOgcLink } from "./types.js";

const CATALOG_COLLECTION_ID = "honua-catalog";

/** Catalog record kind: a published service, or a dataset published as a Layer. */
export type HonuaCatalogItemType = "service" | "dataset";

/** The Honua resource a catalog record describes. */
export type HonuaCatalogResourceType = "Service" | "Layer";

export interface HonuaCatalogItemProperties {
  readonly title?: string | null;
  readonly description?: string | null;
  readonly type: HonuaCatalogItemType;
  readonly resourceType: HonuaCatalogResourceType;
  /** Geometry type of a Layer record, such as `MultiPolygon`. */
  readonly geometryType?: string;
  /** Service name, or publication id and name for a Layer; matched by the `externalIds` filter. */
  readonly externalIds: readonly string[];
  /** Publication ids of the visible Layers a service record groups. */
  readonly layerIds?: readonly string[];
}

/** CRS84 extent polygon of a catalog record. */
export interface HonuaCatalogExtentGeometry {
  readonly type: "Polygon";
  readonly coordinates: readonly (readonly (readonly number[])[])[];
}

/**
 * One catalog record. `id` is `service:<name>` or `layer:<publicationId>`.
 * `links` carry the protocol endpoints: `rel: "alternate"` for service and
 * collection documents, `rel: "data"` for downloadable items.
 */
export interface HonuaCatalogItem {
  readonly type: "Feature";
  readonly id: string;
  readonly geometry: HonuaCatalogExtentGeometry | null;
  readonly bbox?: readonly [west: number, south: number, east: number, north: number];
  readonly properties: HonuaCatalogItemProperties;
  readonly links: readonly HonuaOgcLink[];
}

/** One page of catalog records. A `rel: "next"` link is present while more records match. */
export interface HonuaCatalogPage {
  readonly type: "FeatureCollection";
  readonly features: readonly HonuaCatalogItem[];
  readonly numberMatched: number;
  readonly numberReturned: number;
  readonly links: readonly HonuaOgcLink[];
}

export interface HonuaCatalogRequestOptions {
  readonly signal?: AbortSignal;
  readonly headers?: HeadersInit;
}

export interface HonuaCatalogQuery extends HonuaCatalogRequestOptions {
  /** Search terms over id, title and description; several terms match any of them. */
  readonly q?: string | readonly string[];
  readonly type?: HonuaCatalogItemType | readonly HonuaCatalogItemType[];
  readonly ids?: string | readonly string[];
  readonly externalIds?: string | readonly string[];
  /** CRS84 `[west, south, east, north]`; west greater than east crosses the antimeridian. */
  readonly bbox?: readonly [west: number, south: number, east: number, north: number];
  /** RFC 3339 instant or interval; `..` leaves a bound open. Matches the record's last update. */
  readonly datetime?: string;
  /** Page size, 1 to 1,000 (server default 10; larger values are capped). */
  readonly limit?: number;
  readonly offset?: number;
}

export function listCatalog(transport: HonuaProtocolTransport, query: HonuaCatalogQuery): Promise<HonuaCatalogPage> {
  const { q, type, ids, externalIds, bbox, datetime, limit, offset } = query;
  return transport.requestJson<HonuaCatalogPage>(
    "GET",
    buildOgcRecordsSearchPath({
      collectionId: CATALOG_COLLECTION_ID,
      q,
      type,
      ids,
      externalIds,
      bbox,
      datetime,
      limit,
      offset,
    }),
    { headers: query.headers },
    query.signal,
  );
}

export function getCatalogItem(
  transport: HonuaProtocolTransport,
  id: string,
  options: HonuaCatalogRequestOptions,
): Promise<HonuaCatalogItem> {
  return transport.requestJson<HonuaCatalogItem>(
    "GET",
    buildOgcRecordPath({ collectionId: CATALOG_COLLECTION_ID, recordId: id }),
    { headers: options.headers },
    options.signal,
  );
}
