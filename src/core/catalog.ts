import type { HonuaProtocolTransport } from "./protocol-transport.js";

export type HonuaCatalogItemType = "folder" | "service" | "layer" | "app";
export type HonuaCatalogAccess = "public" | "org" | "private";
export type HonuaCatalogFacetName = "type" | "protocol" | "folder" | "tag" | "owner";

export interface HonuaCatalogLink {
  readonly protocol: string;
  readonly href: string;
}

export interface HonuaCatalogItem {
  readonly id: string;
  readonly type: HonuaCatalogItemType;
  readonly title: string;
  readonly description?: string | null;
  readonly owner: string;
  readonly access: HonuaCatalogAccess;
  readonly created?: string | null;
  readonly updated?: string | null;
  readonly folder?: string | null;
  readonly serviceId?: string | null;
  readonly url?: string | null;
  readonly tags: readonly string[];
  readonly layers: readonly string[];
  readonly endpoints: readonly HonuaCatalogLink[];
  readonly extent?: {
    readonly west: number;
    readonly south: number;
    readonly east: number;
    readonly north: number;
  } | null;
  readonly temporalExtent?: { readonly start?: string | null; readonly end?: string | null } | null;
}

export interface HonuaCatalogFacet {
  readonly value: string;
  readonly count: number;
}

export interface HonuaCatalogPage {
  readonly items: readonly HonuaCatalogItem[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly facets: Readonly<Record<HonuaCatalogFacetName, readonly HonuaCatalogFacet[]>>;
}

export interface HonuaCatalogRequestOptions {
  readonly signal?: AbortSignal;
  readonly headers?: HeadersInit;
}

export interface HonuaCatalogQuery extends HonuaCatalogRequestOptions {
  readonly q?: string;
  readonly type?: HonuaCatalogItemType;
  readonly protocol?: string;
  readonly folder?: string;
  readonly tag?: string;
  readonly owner?: string;
  readonly bbox?: readonly [west: number, south: number, east: number, north: number];
  readonly datetime?: string;
  readonly offset?: number;
  readonly limit?: number;
}

export function listCatalog(transport: HonuaProtocolTransport, request: HonuaCatalogQuery): Promise<HonuaCatalogPage> {
  const { signal, headers, bbox, ...filters } = request;
  const parameters = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) {
    if (value !== undefined) parameters.set(name, String(value));
  }
  if (bbox !== undefined) parameters.set("bbox", bbox.join(","));
  const query = parameters.size === 0 ? "" : `?${parameters}`;
  return transport.requestJson("GET", `/api/v1/catalog${query}`, { headers }, signal) as Promise<HonuaCatalogPage>;
}

export function getCatalogItem(
  transport: HonuaProtocolTransport,
  request: HonuaCatalogRequestOptions & { readonly id: string },
): Promise<HonuaCatalogItem> {
  return transport.requestJson(
    "GET",
    `/api/v1/catalog/${encodeURIComponent(request.id)}`,
    { headers: request.headers },
    request.signal,
  ) as Promise<HonuaCatalogItem>;
}
