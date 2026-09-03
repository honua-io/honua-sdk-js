/**
 * Dynamic STAC catalog, search, pagination, and asset workflow facade.
 *
 * @experimental
 * @packageDocumentation
 */

import type { CloudNativeMaturity } from "../cloud-native-discovery/index.js";
import { rasterDiscoveryRegistryEntry } from "../raster/source-registry.js";
import { HonuaClient } from "../core/client.js";
import { HonuaAbortError, HonuaCapabilityNotSupportedError, HonuaDiscoveryError } from "../core/errors.js";
import { HonuaStacSearch } from "../core/stac.js";
import type {
  HonuaClientOptions,
  HonuaOgcCollectionMetadata,
  HonuaOgcCollectionSummary,
  HonuaOgcLink,
  HonuaStacAsset,
  HonuaStacItemCollectionResponse,
  HonuaStacItemResponse,
  HonuaStacLandingResponse,
  StacSearchRequest,
} from "../core/types.js";
export type { CloudNativeMaturity } from "../cloud-native-discovery/index.js";

export type {
  HonuaOgcCollectionMetadata,
  HonuaOgcCollectionSummary,
  HonuaOgcLink,
  HonuaStacAsset,
  HonuaStacItemCollectionResponse,
  HonuaStacItemResponse,
  HonuaStacLandingResponse,
  HonuaStacRasterBand,
  StacSearchRequest,
  StacSortField,
} from "../core/types.js";

export const DYNAMIC_STAC_CAPABILITY_STATUS = Object.freeze({
  catalog: { client: "supported", server: "required", endToEnd: "supported-when-advertised" },
  getSearch: { client: "supported", server: "required", endToEnd: "supported-when-advertised" },
  postSearch: { client: "supported", server: "optional", endToEnd: "supported-when-advertised" },
  cql2: { client: "supported", server: "optional", endToEnd: "supported-when-advertised" },
  assetHandoff: { client: "experimental", server: "not-applicable", endToEnd: "experimental" },
  zarr: {
    client: rasterDiscoveryRegistryEntry("zarr").client,
    server: rasterDiscoveryRegistryEntry("zarr").server,
    endToEnd: rasterDiscoveryRegistryEntry("zarr").endToEnd,
  },
  netcdf: {
    client: rasterDiscoveryRegistryEntry("netcdf").client,
    server: rasterDiscoveryRegistryEntry("netcdf").server,
    endToEnd: rasterDiscoveryRegistryEntry("netcdf").endToEnd,
  },
} as const);

export type StacSearchMethod = "GET" | "POST" | "auto";
export type StacAssetFormat = "cog" | "pmtiles" | "geoparquet" | "geoarrow" | "raster" | "unsupported";
export type StacKnownAssetRole = "data" | "visual" | "thumbnail" | "overview" | "metadata";
export type StacAssetRole = StacKnownAssetRole | (string & {});
export type StacCommonBandName =
  | "coastal"
  | "blue"
  | "green"
  | "red"
  | "yellow"
  | "pan"
  | "rededge"
  | "nir"
  | "nir08"
  | "nir09"
  | "cirrus"
  | "swir16"
  | "swir22"
  | "lwir"
  | "lwir11"
  | "lwir12"
  | (string & {});

export interface DynamicStacClientOptions {
  /** STAC API root, for example `https://demo.honua.io/api/stac`. */
  readonly baseUrl: string;
  /** Defaults to an empty path because baseUrl is the STAC API root. */
  readonly basePath?: string;
  readonly clientOptions?: Omit<HonuaClientOptions, "baseUrl">;
  readonly refreshAssetUrl?: StacSignedUrlRefresh;
}

export interface DynamicStacSearchRequest
  extends Omit<StacSearchRequest, "usePost" | "allowPostFallback" | "stacBasePath"> {
  /** `auto` discovers POST support once and otherwise uses standard GET search. */
  readonly method?: StacSearchMethod;
}

export interface DynamicStacPageRequest extends DynamicStacSearchRequest {
  readonly pageSize?: number;
  readonly maxPages?: number;
  /** Starts at most one next-page request while the current page is consumed. */
  readonly prefetchPages?: 0 | 1;
}

export interface DynamicStacCatalog {
  readonly landing: HonuaStacLandingResponse;
  readonly conformsTo: readonly string[];
  readonly collections: readonly HonuaOgcCollectionSummary[];
  readonly links: readonly ResolvedStacLink[];
}

export interface ResolvedStacLink {
  readonly href: string;
  readonly rel?: string;
  readonly mediaType?: string;
  readonly title?: string;
  readonly method: "GET" | "POST";
  readonly body?: Readonly<Record<string, unknown>>;
}

export interface StacProjectionMetadata {
  readonly code?: string;
  readonly epsg?: number;
  readonly bbox?: readonly number[];
  readonly shape?: readonly number[];
  readonly transform?: readonly number[];
}

export interface StacRasterBandDescriptor {
  readonly name?: string;
  readonly commonName?: StacCommonBandName;
  readonly description?: string;
  readonly dataType?: string;
  readonly unit?: string;
  readonly nodata?: number | null;
  readonly scale?: number;
  readonly offset?: number;
  readonly spatialResolution?: number;
}

export type StacAssetHandoff =
  | { readonly kind: "cog"; readonly href: string; readonly packageExport: "@honua/sdk-js/cog" }
  | { readonly kind: "pmtiles"; readonly href: string; readonly packageExport: "@honua/sdk-js/pmtiles" }
  | {
      readonly kind: "geoparquet";
      readonly href: string;
      readonly packageExport: "@honua/sdk-js/columnar-workflow";
      readonly geoArrowEncoding: boolean;
    }
  | { readonly kind: "raster"; readonly href: string; readonly packageExport: "@honua/sdk-js/runtime" };

export interface DynamicStacAssetDescriptor {
  readonly itemId: string;
  readonly collectionId?: string;
  readonly key: string;
  readonly href: string;
  readonly title?: string;
  readonly mediaType?: string;
  readonly roles: readonly StacAssetRole[];
  readonly format: StacAssetFormat;
  readonly maturity: CloudNativeMaturity;
  readonly projection: StacProjectionMetadata;
  readonly bands: readonly StacRasterBandDescriptor[];
  readonly evidence: readonly string[];
  readonly handoff?: StacAssetHandoff;
}

export interface StacAssetSelectionOptions {
  readonly roles?: readonly StacAssetRole[];
  readonly formats?: readonly Exclude<StacAssetFormat, "unsupported">[];
  readonly assetKeys?: readonly string[];
  readonly signal?: AbortSignal;
  readonly refreshAssetUrl?: StacSignedUrlRefresh;
}

export interface StacSignedUrlRefreshContext {
  readonly item: HonuaStacItemResponse;
  readonly assetKey: string;
  readonly asset: HonuaStacAsset;
  readonly signal?: AbortSignal;
}

export type StacSignedUrlRefreshResult = string | { readonly href: string; readonly expiresAt?: string };
export type StacSignedUrlRefresh = (
  context: StacSignedUrlRefreshContext,
) => StacSignedUrlRefreshResult | Promise<StacSignedUrlRefreshResult>;

/** Public dynamic STAC workflow facade backed by the standard Honua request pipeline. */
export class DynamicStacClient {
  public readonly client: HonuaClient;
  private readonly api: HonuaStacSearch;
  private readonly baseUrl: string;
  private readonly resolutionBaseUrl: string;
  private readonly refreshAssetUrl: StacSignedUrlRefresh | undefined;

  public constructor(options: DynamicStacClientOptions) {
    this.baseUrl = normalizeHttpUrl(options.baseUrl, "STAC base URL");
    this.resolutionBaseUrl = mountedStacBaseUrl(this.baseUrl, options.basePath ?? "");
    this.client = new HonuaClient({ baseUrl: this.baseUrl, ...options.clientOptions });
    this.api = new HonuaStacSearch({ client: this.client, basePath: options.basePath ?? "" });
    this.refreshAssetUrl = options.refreshAssetUrl;
  }

  public async catalog(signal?: AbortSignal): Promise<DynamicStacCatalog> {
    const [landing, collectionResponse] = await Promise.all([
      this.api.landing({ signal }),
      this.api.collections({ signal }),
    ]);
    const links = [...(landing.links ?? []), ...(collectionResponse.links ?? [])].map((link) =>
      resolveStacLink(link, this.resolutionBaseUrl),
    );
    return {
      landing,
      conformsTo: landing.conformsTo ?? [],
      collections: collectionResponse.collections ?? [],
      links,
    };
  }

  public async collection(collectionId: string, signal?: AbortSignal): Promise<HonuaOgcCollectionMetadata> {
    return this.api.collection({ collectionId, signal });
  }

  public async item(collectionId: string, itemId: string, signal?: AbortSignal): Promise<HonuaStacItemResponse> {
    return this.api.item({ collectionId, itemId, signal });
  }

  public async search(request: DynamicStacSearchRequest = {}): Promise<HonuaStacItemCollectionResponse> {
    return this.api.search(await this.wireSearchRequest(request));
  }

  public async *pages(request: DynamicStacPageRequest = {}): AsyncGenerator<readonly HonuaStacItemResponse[]> {
    const pageSize = boundedInteger(request.pageSize ?? request.limit ?? 100, 1, 1_000, "pageSize");
    const maxPages = boundedInteger(request.maxPages ?? 100, 1, 100, "maxPages");
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) controller.abort();
    let iterator: AsyncGenerator<HonuaStacItemResponse[], void, undefined> | undefined;
    let pending: Promise<IteratorResult<HonuaStacItemResponse[], void>> | undefined;
    try {
      const wire = await this.wireSearchRequest({ ...request, signal: controller.signal });
      iterator = this.api.searchStream({ ...wire, pageSize, maxPages, signal: controller.signal });
      let current = await iterator.next();
      while (true) {
        if (current.done) break;
        if (request.prefetchPages === 1) {
          pending = iterator.next();
          void pending.catch(() => undefined);
          yield current.value;
          current = await pending;
          pending = undefined;
        } else {
          yield current.value;
          current = await iterator.next();
        }
      }
    } finally {
      request.signal?.removeEventListener("abort", abort);
      controller.abort();
      if (pending) await pending.catch(() => undefined);
      if (iterator) await iterator.return(undefined).catch(() => undefined);
    }
  }

  public async *items(request: DynamicStacPageRequest = {}): AsyncGenerator<HonuaStacItemResponse> {
    for await (const page of this.pages(request)) {
      for (const item of page) yield item;
    }
  }

  public async assets(
    item: HonuaStacItemResponse,
    options: StacAssetSelectionOptions = {},
  ): Promise<readonly DynamicStacAssetDescriptor[]> {
    const out: DynamicStacAssetDescriptor[] = [];
    for (const [key, asset] of Object.entries(item.assets ?? {})) {
      if (options.signal?.aborted) throw new HonuaAbortError();
      if (options.assetKeys && !options.assetKeys.includes(key)) continue;
      const roles = normalizeRoles(asset.roles);
      if (options.roles && !options.roles.some((role) => roles.includes(role))) continue;
      const originalHref = normalizeHttpUrl(
        new URL(asset.href, itemBaseUrl(item, this.resolutionBaseUrl)).href,
        `STAC asset ${key}`,
      );
      const descriptor = describeAsset(item, key, asset, originalHref, roles);
      if (options.formats && !options.formats.includes(descriptor.format as Exclude<StacAssetFormat, "unsupported">)) {
        continue;
      }
      const refreshed = await (options.refreshAssetUrl ?? this.refreshAssetUrl)?.({
        item,
        assetKey: key,
        asset,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (options.signal?.aborted) throw new HonuaAbortError();
      const rawHref = typeof refreshed === "string" ? refreshed : (refreshed?.href ?? originalHref);
      const href = normalizeHttpUrl(
        new URL(rawHref, itemBaseUrl(item, this.resolutionBaseUrl)).href,
        `STAC asset ${key}`,
      );
      out.push({
        ...descriptor,
        href,
        ...(descriptor.handoff ? { handoff: { ...descriptor.handoff, href } } : {}),
      });
    }
    return out;
  }

  public async selectAsset(
    item: HonuaStacItemResponse,
    options: StacAssetSelectionOptions = {},
  ): Promise<DynamicStacAssetDescriptor> {
    const candidates = await this.assets(item, options);
    const selected = candidates.find((asset) => asset.handoff !== undefined && asset.maturity !== "unavailable");
    if (!selected) {
      throw new HonuaCapabilityNotSupportedError("asset-handoff", "stac", String(item.id), {
        context: { roles: options.roles, formats: options.formats, assetKeys: options.assetKeys },
      });
    }
    return selected;
  }

  private async wireSearchRequest(request: DynamicStacSearchRequest): Promise<StacSearchRequest> {
    const { method = "auto", ...rest } = request;
    const usePost = method === "POST" || (method === "auto" && (await this.api.supportsPostSearch(request.signal)));
    return { ...rest, usePost, allowPostFallback: method === "auto" };
  }
}

export function createDynamicStacClient(options: DynamicStacClientOptions): DynamicStacClient {
  return new DynamicStacClient(options);
}

export function resolveStacLink(link: HonuaOgcLink, fromUrl: string): ResolvedStacLink {
  const href = normalizeHttpUrl(new URL(link.href, fromUrl).href, "STAC link");
  const method = typeof link.method === "string" && link.method.toUpperCase() === "POST" ? "POST" : "GET";
  return {
    href,
    ...(link.rel ? { rel: link.rel } : {}),
    ...(link.type ? { mediaType: link.type } : {}),
    ...(link.title ? { title: link.title } : {}),
    method,
    ...(isRecord(link.body) ? { body: { ...link.body } } : {}),
  };
}

function describeAsset(
  item: HonuaStacItemResponse,
  key: string,
  asset: HonuaStacAsset,
  href: string,
  roles: readonly StacAssetRole[],
): DynamicStacAssetDescriptor {
  const mediaType = asset.type?.toLowerCase();
  const path = new URL(href).pathname.toLowerCase();
  const evidence: string[] = [];
  let format: StacAssetFormat = "unsupported";
  if (mediaType?.includes("pmtiles") || path.endsWith(".pmtiles")) format = "pmtiles";
  else if (mediaType?.includes("geoparquet") || mediaType?.includes("parquet") || path.endsWith(".parquet")) {
    format = mediaType?.includes("arrow") ? "geoarrow" : "geoparquet";
  } else if (mediaType?.includes("arrow") || path.endsWith(".arrow") || path.endsWith(".feather")) format = "geoarrow";
  else if (mediaType?.startsWith("image/tiff") && mediaTypeParameterEquals(mediaType, "profile", "cloud-optimized")) {
    format = "cog";
  } else if (mediaType?.startsWith("image/") && !mediaType.includes("tiff")) format = "raster";
  if (asset.type) evidence.push(`media-type:${asset.type}`);
  if (roles.length > 0) evidence.push(`roles:${roles.join(",")}`);
  if (path.includes(".")) evidence.push(`url-suffix:${path.slice(path.lastIndexOf("."))}`);

  const maturity = ASSET_MATURITY[format];
  const projection = projectionMetadata(item, asset);
  const bands = rasterBands(asset);
  const base = {
    itemId: String(item.id),
    ...(item.collection ? { collectionId: item.collection } : {}),
    key,
    href,
    ...(asset.title ? { title: asset.title } : {}),
    ...(asset.type ? { mediaType: asset.type } : {}),
    roles,
    format,
    maturity,
    projection,
    bands,
    evidence,
  };
  switch (format) {
    case "cog":
      return { ...base, handoff: { kind: "cog", href, packageExport: "@honua/sdk-js/cog" } };
    case "pmtiles":
      return { ...base, handoff: { kind: "pmtiles", href, packageExport: "@honua/sdk-js/pmtiles" } };
    case "geoparquet":
      return {
        ...base,
        handoff: {
          kind: "geoparquet",
          href,
          packageExport: "@honua/sdk-js/columnar-workflow",
          geoArrowEncoding: mediaType?.includes("arrow") === true,
        },
      };
    case "raster":
      return { ...base, handoff: { kind: "raster", href, packageExport: "@honua/sdk-js/runtime" } };
    default:
      return base;
  }
}

function projectionMetadata(item: HonuaStacItemResponse, asset: HonuaStacAsset): StacProjectionMetadata {
  const properties = isRecord(item.properties) ? item.properties : {};
  return {
    ...optionalString(asset["proj:code"] ?? properties["proj:code"], "code"),
    ...optionalNumber(asset["proj:epsg"] ?? properties["proj:epsg"], "epsg"),
    ...optionalNumberArray(asset["proj:bbox"] ?? properties["proj:bbox"], "bbox"),
    ...optionalNumberArray(asset["proj:shape"] ?? properties["proj:shape"], "shape"),
    ...optionalNumberArray(asset["proj:transform"] ?? properties["proj:transform"], "transform"),
  };
}

function rasterBands(asset: HonuaStacAsset): readonly StacRasterBandDescriptor[] {
  if (!Array.isArray(asset["raster:bands"])) return [];
  return asset["raster:bands"].filter(isRecord).map((band) => ({
    ...optionalString(band.name, "name"),
    ...optionalString(band.common_name, "commonName"),
    ...optionalString(band.description, "description"),
    ...optionalString(band.data_type, "dataType"),
    ...optionalString(band.unit, "unit"),
    ...(typeof band.nodata === "number" || band.nodata === null ? { nodata: band.nodata } : {}),
    ...optionalNumber(band.scale, "scale"),
    ...optionalNumber(band.offset, "offset"),
    ...optionalNumber(band.spatial_resolution, "spatialResolution"),
  }));
}

function itemBaseUrl(item: HonuaStacItemResponse, fallback: string): string {
  const self = item.links?.find((link) => link.rel === "self" && typeof link.href === "string");
  return self ? new URL(self.href, fallback).href : fallback;
}

function normalizeRoles(roles: readonly string[] | undefined): readonly StacAssetRole[] {
  return (roles ?? []).filter((role): role is StacAssetRole => typeof role === "string" && role.length > 0);
}

function mediaTypeParameterEquals(mediaType: string, name: string, expectedValue: string): boolean {
  for (const rawParameter of mediaType.split(";").slice(1)) {
    const separator = rawParameter.indexOf("=");
    if (separator < 0) continue;
    const parameterName = rawParameter.slice(0, separator).trim().toLowerCase();
    if (parameterName !== name) continue;
    const rawValue = rawParameter.slice(separator + 1).trim();
    const value =
      rawValue.length >= 2 &&
      ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'")))
        ? rawValue.slice(1, -1)
        : rawValue;
    return value.toLowerCase() === expectedValue;
  }
  return false;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new HonuaDiscoveryError("invalid-capability", `${name} must be an integer from ${minimum} to ${maximum}.`, {
      [name]: value,
    });
  }
  return value;
}

function normalizeHttpUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      `${label} must be an absolute HTTP(S) URL.`,
      { value },
      { cause },
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HonuaDiscoveryError("invalid-endpoint", `${label} must use HTTP or HTTPS.`, {
      value,
      protocol: url.protocol,
    });
  }
  url.hash = "";
  return url.href;
}

function ensureDirectoryUrl(value: string): string {
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

function mountedStacBaseUrl(baseUrl: string, basePath: string): string {
  let mountStart = 0;
  while (mountStart < basePath.length && basePath.charCodeAt(mountStart) === 47) mountStart += 1;
  let mountEnd = basePath.length;
  while (mountEnd > mountStart && basePath.charCodeAt(mountEnd - 1) === 47) mountEnd -= 1;
  const mount = basePath.slice(mountStart, mountEnd);
  if (mount.length === 0) return ensureDirectoryUrl(baseUrl);

  const url = new URL(baseUrl);
  let baseEnd = url.pathname.length;
  while (baseEnd > 0 && url.pathname.charCodeAt(baseEnd - 1) === 47) baseEnd -= 1;
  url.pathname = `${url.pathname.slice(0, baseEnd)}/${mount}/`;
  return url.href;
}

function optionalString<Key extends string>(value: unknown, key: Key): Partial<Record<Key, string>> {
  return typeof value === "string" && value.length > 0 ? ({ [key]: value } as Record<Key, string>) : {};
}

function optionalNumber<Key extends string>(value: unknown, key: Key): Partial<Record<Key, number>> {
  return typeof value === "number" && Number.isFinite(value) ? ({ [key]: value } as Record<Key, number>) : {};
}

function optionalNumberArray<Key extends string>(value: unknown, key: Key): Partial<Record<Key, readonly number[]>> {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ? ({ [key]: [...value] } as unknown as Record<Key, readonly number[]>)
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ASSET_MATURITY = {
  cog: "experimental",
  pmtiles: "supported",
  geoparquet: "experimental",
  geoarrow: "metadata-only",
  raster: "supported",
  unsupported: "unavailable",
} as const satisfies Record<StacAssetFormat, CloudNativeMaturity>;
