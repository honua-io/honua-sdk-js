import { HonuaClient } from "../core/client.js";
import type { HonuaRequestInterceptor } from "../core/types.js";
import { esriConfig } from "./esri-config.js";
import { FeatureLayerCompat } from "./feature-layer.js";
import { identityManager } from "./identity-manager.js";
import { createArcGisTokenInterceptor } from "./request.js";
import { parseFeatureLayerUrl, parseImageServiceUrl, parseMapServiceUrl } from "./url.js";

/**
 * A single item as returned by the Honua Portal facade
 * (`/sharing/rest/search` and `/sharing/rest/content/items/{id}`). Mirrors the
 * ArcGIS Portal item shape so a repointed app reads the same fields.
 */
export interface PortalItem {
  id: string;
  owner: string;
  created: number;
  modified: number;
  type: string;
  typeKeywords: string[];
  title: string;
  snippet: string | null;
  description: string | null;
  tags: string[];
  /** Absolute service URL, e.g. `.../rest/services/{name}/FeatureServer`. */
  url: string | null;
  access: "public" | "org" | "private" | string;
  extent: number[][] | null;
  spatialReference: string | null;
  culture: string | null;
  numComments: number;
  numViews: number;
  [key: string]: unknown;
}

/** Parsed `/sharing/rest/search` response. */
export interface PortalSearchResult {
  query: string;
  total: number;
  /** 1-based index of the first result in this page. */
  start: number;
  num: number;
  /** Index of the next page's first result, or `-1` on the last page. */
  nextStart: number;
  results: PortalItem[];
}

/** `/sharing/rest/info` response (subset the client relies on). */
export interface PortalInfo {
  authInfo?: {
    isTokenBasedSecurity?: boolean;
    tokenServicesUrl?: string;
  };
  [key: string]: unknown;
}

/** `/sharing/rest/portals/self` response (subset the client relies on). */
export interface PortalSelf {
  id?: string;
  isPortal?: boolean;
  name?: string;
  portalName?: string;
  user?: {
    username: string;
    fullName?: string;
    role?: string;
  } | null;
  [key: string]: unknown;
}

/** Options accepted by {@link PortalCompat}. */
export interface PortalCompatOptions {
  /**
   * Portal base URL. Accepts either a portal root (`https://portal.example`) or
   * a `/sharing/rest` base; both normalize to the `.../sharing/rest` endpoint
   * base. Defaults to {@link esriConfig.portalUrl}.
   */
  portalUrl?: string;
  /** Pre-obtained token to attach to authenticated calls. */
  token?: string;
  /** Static API key (falls back to {@link esriConfig.apiKey}). */
  apiKey?: string;
  /** Override the global `fetch` implementation (useful in tests). */
  fetchFn?: typeof fetch;
}

/** Options for {@link PortalCompat.generateToken}. */
export interface PortalGenerateTokenOptions {
  username: string;
  password: string;
  /** Referer registered with the token. Defaults to the portal origin. */
  referer?: string;
  /** Esri `client` param (`"referer"` | `"requestip"` | `"ip"`). Defaults to `"referer"`. */
  client?: string;
  /** Token lifetime in minutes. */
  expirationMinutes?: number;
}

/** Result of {@link PortalCompat.generateToken}. */
export interface PortalTokenCredential {
  token: string;
  /** Absolute expiry as a unix-millisecond timestamp. */
  expiresAtMs: number;
  ssl: boolean;
}

/** Options for {@link PortalCompat.search}. */
export interface PortalSearchOptions {
  q?: string;
  start?: number;
  num?: number;
  token?: string;
}

/** Options for {@link PortalCompat.getItem}. */
export interface PortalGetItemOptions {
  token?: string;
}

/** Options for {@link PortalCompat.openFeatureLayer}. */
export interface PortalOpenOptions {
  /** Layer id to open for Feature Service items. Defaults to the service's first advertised layer. */
  layerId?: number;
}

interface PortalOpenResultBase {
  /** Resolved portal item. */
  item: PortalItem;
  /** Service base (`.../rest/services`-prefixed origin/prefix) without the service segment. */
  baseUrl: string;
  /** Service (folder/name) id parsed from the item URL. */
  serviceId: string;
  /** Authenticated client bound to `baseUrl`, carrying the portal credential. */
  client: HonuaClient;
}

/** Feature Service open result: includes a ready-to-use {@link FeatureLayerCompat}. */
export interface PortalFeatureServiceOpenResult extends PortalOpenResultBase {
  type: "feature-service";
  layerId: number;
  layer: FeatureLayerCompat;
}

/** Map/Image Service open result: the resolved, authenticated service handle. */
export interface PortalServiceOpenResult extends PortalOpenResultBase {
  type: "map-service" | "image-service";
}

export type PortalOpenResult = PortalFeatureServiceOpenResult | PortalServiceOpenResult;

/** Error thrown when the Portal facade returns an Esri error envelope. */
export class PortalError extends Error {
  public readonly code: number | string | undefined;
  public readonly details: unknown;

  public constructor(message: string, code?: number | string, details?: unknown) {
    super(message);
    this.name = "PortalError";
    this.code = code;
    this.details = details;
  }
}

interface EsriErrorEnvelope {
  error?: {
    code?: number | string;
    message?: string;
    details?: unknown;
  };
}

/**
 * Client for a Honua `/sharing/rest` Portal facade. Lets a repointed ArcGIS app
 * authenticate, search for items, and open an item that resolves to a
 * `/rest/services` URL — carrying the portal token through to the opened layer
 * so the whole flow authenticates end to end.
 *
 * @example
 * ```ts
 * import { PortalCompat } from "@honua/sdk-js/esri-compat";
 *
 * const portal = new PortalCompat({ portalUrl: "https://honua.example" });
 * await portal.generateToken({ username: "u", password: "p" });
 * const { results } = await portal.search({ q: "roads" });
 * const opened = await portal.openFeatureLayer(results[0]);
 * if (opened.type === "feature-service") {
 *   await opened.layer.queryFeatures({ where: "1=1" });
 * }
 * ```
 */
export class PortalCompat {
  /** Normalized `.../sharing/rest` base for this portal. */
  public readonly sharingRestBase: string;
  private token: string | undefined;
  private tokenExpiresAtMs: number | undefined;
  private readonly apiKey: string | undefined;
  private readonly fetchFn: typeof fetch;

  public constructor(options: PortalCompatOptions = {}) {
    this.sharingRestBase = normalizeSharingRestBase(options.portalUrl ?? esriConfig.portalUrl);
    this.token = options.token;
    this.tokenExpiresAtMs = undefined;
    this.apiKey = options.apiKey ?? esriConfig.apiKey;
    // Bind so passing a bare `window.fetch`/`globalThis.fetch` cannot throw an
    // "Illegal invocation" when called as `this.fetchFn(...)`.
    this.fetchFn = (options.fetchFn ?? fetch).bind(globalThis);
  }

  /** The currently held portal token, if any. */
  public getToken(): string | undefined {
    return this.token;
  }

  /**
   * Exchange username/password for a portal token via
   * `POST /sharing/rest/generateToken`. Stores the token on this instance and
   * returns the credential (`expires` ms → `expiresAtMs`).
   */
  public async generateToken(options: PortalGenerateTokenOptions): Promise<PortalTokenCredential> {
    const referer = options.referer ?? defaultReferer(this.sharingRestBase);
    const body = new URLSearchParams();
    body.set("username", options.username);
    body.set("password", options.password);
    body.set("client", options.client ?? "referer");
    if (referer) {
      body.set("referer", referer);
    }
    if (typeof options.expirationMinutes === "number" && Number.isFinite(options.expirationMinutes)) {
      body.set("expiration", String(options.expirationMinutes));
    }
    body.set("f", "json");

    const response = await this.fetchFn(`${this.sharingRestBase}/generateToken`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json = (await response.json()) as EsriErrorEnvelope & {
      token?: string;
      expires?: number;
      ssl?: boolean;
    };
    throwIfEsriError(json, "Portal generateToken failed.");

    if (typeof json.token !== "string" || json.token.length === 0) {
      throw new PortalError("Portal generateToken response did not include a token.");
    }
    const expiresAtMs = typeof json.expires === "number" && Number.isFinite(json.expires) ? json.expires : 0;
    this.token = json.token;
    this.tokenExpiresAtMs = expiresAtMs || undefined;
    return { token: json.token, expiresAtMs, ssl: json.ssl ?? true };
  }

  /** `GET /sharing/rest/info`. */
  public async getInfo(): Promise<PortalInfo> {
    return this.getJson<PortalInfo>("/info", {}, undefined);
  }

  /** `GET /sharing/rest/portals/self` (attaches the token when present). */
  public async getPortalSelf(): Promise<PortalSelf> {
    return this.getJson<PortalSelf>("/portals/self", {}, this.token);
  }

  /** `GET /sharing/rest/search`. */
  public async search(options: PortalSearchOptions = {}): Promise<PortalSearchResult> {
    const params: Record<string, string | number | undefined> = {
      q: options.q,
      start: options.start,
      num: options.num,
    };
    const raw = await this.getJson<Partial<PortalSearchResult>>("/search", params, options.token ?? this.token);
    return {
      query: raw.query ?? options.q ?? "",
      total: raw.total ?? 0,
      start: raw.start ?? options.start ?? 1,
      num: raw.num ?? options.num ?? 0,
      nextStart: raw.nextStart ?? -1,
      results: Array.isArray(raw.results) ? raw.results : [],
    };
  }

  /** `GET /sharing/rest/content/items/{id}`. */
  public async getItem(itemId: string, options: PortalGetItemOptions = {}): Promise<PortalItem> {
    return this.getJson<PortalItem>(`/content/items/${encodeURIComponent(itemId)}`, {}, options.token ?? this.token);
  }

  /**
   * Resolve an item (fetching it when given an id), parse its service `url`, and
   * return an authenticated handle. Feature Service items yield a
   * {@link FeatureLayerCompat} bound to a client carrying the portal token;
   * Map/Image Service items yield the resolved `{ baseUrl, serviceId, client }`.
   */
  public async openFeatureLayer(
    itemOrId: string | PortalItem,
    options: PortalOpenOptions = {},
  ): Promise<PortalOpenResult> {
    const item = typeof itemOrId === "string" ? await this.getItem(itemOrId) : itemOrId;
    if (!item.url) {
      throw new PortalError(`Portal item ${item.id} has no service URL to open.`);
    }
    const serviceUrl = trimTrailingSlashes(item.url);

    if (isFeatureService(item.type, serviceUrl)) {
      const hasLayerId = /\/FeatureServer\/\d+$/i.test(serviceUrl);
      const service = parseFeatureLayerUrl(hasLayerId ? serviceUrl : `${serviceUrl}/0`);
      const client = this.buildAuthenticatedClient(service.baseUrl);
      let layerId = service.layerId;
      if (!hasLayerId) {
        if (options.layerId !== undefined) {
          layerId = options.layerId;
        } else {
          const metadata = await client.getFeatureServiceMetadata(service.serviceId);
          const firstLayerId = metadata.layers?.[0]?.id;
          if (typeof firstLayerId !== "number" || !Number.isSafeInteger(firstLayerId)) {
            throw new PortalError(`Portal Feature Service item ${item.id} does not advertise a layer to open.`);
          }
          layerId = firstLayerId;
        }
      }
      const layerUrl = hasLayerId ? serviceUrl : `${serviceUrl}/${layerId}`;
      const parsed = parseFeatureLayerUrl(layerUrl);
      const layer = new FeatureLayerCompat({ url: layerUrl, client, title: item.title, id: item.id });
      return {
        type: "feature-service",
        item,
        baseUrl: parsed.baseUrl,
        serviceId: parsed.serviceId,
        layerId: parsed.layerId,
        client,
        layer,
      };
    }

    if (isImageService(item.type, serviceUrl)) {
      const parsed = parseImageServiceUrl(serviceUrl);
      const client = this.buildAuthenticatedClient(parsed.baseUrl);
      return { type: "image-service", item, baseUrl: parsed.baseUrl, serviceId: parsed.serviceId, client };
    }

    const parsed = parseMapServiceUrl(serviceUrl);
    const client = this.buildAuthenticatedClient(parsed.baseUrl);
    return { type: "map-service", item, baseUrl: parsed.baseUrl, serviceId: parsed.serviceId, client };
  }

  /**
   * Register the currently held token with the shared {@link identityManager}
   * under this portal's `/sharing/rest` server, so subsequent esri-compat calls
   * resolve the same credential.
   */
  public registerWithIdentityManager(): void {
    if (!this.token) {
      throw new PortalError("PortalCompat has no token to register; call generateToken first.");
    }
    identityManager.registerToken({
      server: this.sharingRestBase,
      token: this.token,
      ...(this.tokenExpiresAtMs !== undefined ? { expires: this.tokenExpiresAtMs } : {}),
    });
  }

  private buildAuthenticatedClient(baseUrl: string): HonuaClient {
    const interceptors: HonuaRequestInterceptor[] = [];
    if (this.token) {
      interceptors.push(createArcGisTokenInterceptor({ getToken: () => this.token }));
    }
    return new HonuaClient({
      baseUrl,
      fetchFn: this.fetchFn,
      ...(this.apiKey ? { apiKey: this.apiKey } : {}),
      ...(interceptors.length > 0 ? { interceptors } : {}),
    });
  }

  private async getJson<T>(
    path: string,
    params: Record<string, string | number | undefined>,
    token: string | undefined,
  ): Promise<T> {
    const query = new URLSearchParams();
    query.set("f", "json");
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        query.set(key, String(value));
      }
    }
    if (token) {
      query.set("token", token);
    }
    const response = await this.fetchFn(`${this.sharingRestBase}${path}?${query.toString()}`);
    const json = (await response.json()) as T & EsriErrorEnvelope;
    throwIfEsriError(json, `Portal request to ${path} failed.`);
    return json;
  }
}

function normalizeSharingRestBase(portalUrl: string): string {
  const trimmed = trimTrailingSlashes(portalUrl);
  if (/\/sharing\/rest$/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/sharing/rest`;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end--;
  }
  return value.slice(0, end);
}

function defaultReferer(sharingRestBase: string): string | undefined {
  if (globalThis.location?.origin) {
    return globalThis.location.origin;
  }
  try {
    return new URL(sharingRestBase).origin;
  } catch {
    return undefined;
  }
}

function isFeatureService(type: string, serviceUrl: string): boolean {
  return /feature\s*service/i.test(type) || /\/FeatureServer(\/\d+)?$/i.test(serviceUrl);
}

function isImageService(type: string, serviceUrl: string): boolean {
  return /image\s*service/i.test(type) || /\/ImageServer(\/\d+)?$/i.test(serviceUrl);
}

function throwIfEsriError(json: EsriErrorEnvelope, fallbackMessage: string): void {
  if (json && typeof json === "object" && json.error) {
    const { code, message, details } = json.error;
    throw new PortalError(message ?? fallbackMessage, code, details);
  }
}
