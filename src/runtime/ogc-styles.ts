/**
 * OGC API – Styles client + StyleRef resolver.
 *
 * Consumes the server's OGC API – Styles surface (honua-server, ADR-0048) so
 * that `styleRefs.styleId` aligns with the server's canonical styleId instead
 * of relying on an ad-hoc, caller-supplied callback:
 *
 *   GET /ogc/styles                       -> { styles: [{ id, title, links }], default? }
 *   GET /ogc/styles/{styleId}             -> MapLibre style document
 *     (Accept: application/vnd.mapbox.style+json — content negotiated)
 *   GET /ogc/styles/{styleId}/metadata    -> style metadata document
 *
 * The {@link createOgcStyleRefResolver} factory adapts the full MapLibre style
 * document returned by `/ogc/styles/{styleId}` into the per-layer
 * {@link HonuaStyleRefBody} override map consumed by `applyStyleRefs`. This is
 * wired as the default StyleRef resolution path in the runtime loader, while a
 * caller-supplied callback remains supported as a back-compat override.
 *
 * @module
 */

import type { HonuaClient } from "../core/client.js";
import { trimTrailingSlashes } from "../core/path-utils.js";
import type { HonuaLayerSpecification, HonuaStyleSpecification } from "../style/specification.js";
import { HonuaMapPackageError } from "./errors.js";
import type { HonuaStyleRefBody, HonuaStyleRefLayerOverride } from "./map-package.js";
import type { StyleRefResolver } from "./style-compose.js";

/** Default path prefix for the server's OGC API – Styles surface. */
export const DEFAULT_OGC_STYLES_PATH_PREFIX = "/ogc/styles";

/**
 * MapLibre style media type used to content-negotiate the encoded style
 * document from `/ogc/styles/{styleId}`. Matches the server default.
 */
export const MAPLIBRE_STYLE_MEDIA_TYPE = "application/vnd.mapbox.style+json";

/** A link entry on a styles list / style metadata document. */
export interface OgcStyleLink {
  readonly rel: string;
  readonly type?: string;
  readonly href: string;
  readonly title?: string;
}

/** One entry in the `/ogc/styles` style list. */
export interface OgcStyleListEntry {
  readonly id: string;
  readonly title?: string;
  readonly links?: readonly OgcStyleLink[];
}

/** Response body of `GET /ogc/styles`. */
export interface OgcStyleList {
  readonly styles: readonly OgcStyleListEntry[];
  /** Server-designated default styleId, when present. */
  readonly default?: string;
}

/** Options shared by the OGC styles client calls. */
export interface OgcStylesRequestOptions {
  readonly signal?: AbortSignal;
  readonly headers?: HeadersInit;
}

/** Options for constructing an OGC styles client. */
export interface OgcStylesClientOptions {
  readonly client: HonuaClient;
  /**
   * Override the OGC styles path prefix. Defaults to
   * {@link DEFAULT_OGC_STYLES_PATH_PREFIX} (`/ogc/styles`).
   */
  readonly pathPrefix?: string;
}

/**
 * Thin client over the server's OGC API – Styles surface. Uses the shared
 * {@link HonuaClient} request pipeline (auth / retry / interceptors), matching
 * the other `/ogc/*` consumers in the SDK.
 */
export class OgcStylesClient {
  private readonly client: HonuaClient;
  private readonly pathPrefix: string;

  constructor(options: OgcStylesClientOptions) {
    this.client = options.client;
    this.pathPrefix = normalizePrefix(options.pathPrefix ?? DEFAULT_OGC_STYLES_PATH_PREFIX);
  }

  /** List available styles via `GET /ogc/styles`. */
  public async listStyles(options: OgcStylesRequestOptions = {}): Promise<OgcStyleList> {
    const body = await this.getJson(this.pathPrefix, "application/json", options);
    return normalizeStyleList(body);
  }

  /**
   * Fetch the MapLibre style document for `styleId` via
   * `GET /ogc/styles/{styleId}` (content-negotiated to
   * {@link MAPLIBRE_STYLE_MEDIA_TYPE}).
   */
  public async getStyle(styleId: string, options: OgcStylesRequestOptions = {}): Promise<HonuaStyleSpecification> {
    const path = this.stylePath(styleId);
    const body = await this.getJson(path, `${MAPLIBRE_STYLE_MEDIA_TYPE}, application/json;q=0.9`, options);
    if (!isRecord(body) || !Array.isArray((body as { layers?: unknown }).layers)) {
      throw new HonuaMapPackageError(`OGC style "${styleId}" did not return a MapLibre style document`, {
        stage: "style-compose",
        detail: { styleId, path },
      });
    }
    return body as unknown as HonuaStyleSpecification;
  }

  /** Fetch the style metadata document via `GET /ogc/styles/{styleId}/metadata`. */
  public async getStyleMetadata(
    styleId: string,
    options: OgcStylesRequestOptions = {},
  ): Promise<Record<string, unknown>> {
    const path = `${this.stylePath(styleId)}/metadata`;
    const body = await this.getJson(path, "application/json", options);
    if (!isRecord(body)) {
      throw new HonuaMapPackageError(`OGC style metadata for "${styleId}" was not an object`, {
        stage: "style-compose",
        detail: { styleId, path },
      });
    }
    return body;
  }

  /** Resolve the request path for a single style. */
  public stylePath(styleId: string): string {
    return `${this.pathPrefix}/${encodeURIComponent(styleId)}`;
  }

  private async getJson(path: string, accept: string, options: OgcStylesRequestOptions): Promise<unknown> {
    const headers = new Headers(options.headers);
    if (!headers.has("Accept")) headers.set("Accept", accept);
    const response = await this.client.pipelineFetch("GET", path, { headers }, options.signal);
    try {
      return await response.json();
    } catch (cause) {
      throw new HonuaMapPackageError(`OGC styles response from "${path}" was not valid JSON`, {
        stage: "style-compose",
        detail: { path },
        cause,
      });
    }
  }
}

/** Options for {@link createOgcStyleRefResolver}. */
export interface OgcStyleRefResolverOptions extends OgcStylesClientOptions, OgcStylesRequestOptions {}

/**
 * Build a {@link StyleRefResolver} backed by the server's `/ogc/styles`
 * surface. The resolver fetches `GET /ogc/styles/{styleId}` (content-negotiated
 * MapLibre) and projects the returned style document's layers into the
 * per-layer {@link HonuaStyleRefBody} override map that `applyStyleRefs`
 * consumes. Layer overrides are keyed by MapLibre layer id; only
 * paint/layout/zoom/filter/metadata are carried over (structural fields such
 * as `source` are intentionally dropped — a StyleRef refines existing layers).
 *
 * The `presetId` argument is currently advisory and not encoded into the
 * request path; the server resolves presets server-side by styleId.
 */
export function createOgcStyleRefResolver(options: OgcStyleRefResolverOptions): StyleRefResolver {
  const ogc = new OgcStylesClient({
    client: options.client,
    ...(options.pathPrefix ? { pathPrefix: options.pathPrefix } : {}),
  });
  const requestOptions: OgcStylesRequestOptions = {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
  };
  return async (styleId: string): Promise<HonuaStyleRefBody> => {
    const style = await ogc.getStyle(styleId, requestOptions);
    return styleDocumentToRefBody(style);
  };
}

/**
 * Project a MapLibre style document into a {@link HonuaStyleRefBody} — a map of
 * per-layer paint/layout overrides keyed by layer id. Layers without any
 * override-relevant fields are omitted.
 */
export function styleDocumentToRefBody(style: HonuaStyleSpecification): HonuaStyleRefBody {
  const body: HonuaStyleRefBody = {};
  for (const layer of style.layers ?? []) {
    if (!layer || typeof layer.id !== "string") continue;
    const override = layerToOverride(layer);
    if (override) body[layer.id] = override;
  }
  return body;
}

function layerToOverride(layer: HonuaLayerSpecification): HonuaStyleRefLayerOverride | undefined {
  const override: HonuaStyleRefLayerOverride = {};
  let hasField = false;
  if (layer.paint !== undefined) {
    override.paint = layer.paint;
    hasField = true;
  }
  if (layer.layout !== undefined) {
    override.layout = layer.layout;
    hasField = true;
  }
  if (layer.minzoom !== undefined) {
    override.minzoom = layer.minzoom;
    hasField = true;
  }
  if (layer.maxzoom !== undefined) {
    override.maxzoom = layer.maxzoom;
    hasField = true;
  }
  if (layer.filter !== undefined) {
    override.filter = layer.filter;
    hasField = true;
  }
  if (layer.metadata !== undefined) {
    override.metadata = layer.metadata;
    hasField = true;
  }
  return hasField ? override : undefined;
}

function normalizeStyleList(body: unknown): OgcStyleList {
  if (!isRecord(body) || !Array.isArray(body.styles)) {
    throw new HonuaMapPackageError("OGC styles list did not contain a styles array", {
      stage: "style-compose",
      detail: { body },
    });
  }
  const styles: OgcStyleListEntry[] = [];
  for (const entry of body.styles) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    styles.push({
      id: entry.id,
      ...(typeof entry.title === "string" ? { title: entry.title } : {}),
      ...(Array.isArray(entry.links) ? { links: entry.links as readonly OgcStyleLink[] } : {}),
    });
  }
  return {
    styles,
    ...(typeof body.default === "string" ? { default: body.default } : {}),
  };
}

function normalizePrefix(prefix: string): string {
  const trimmed = trimTrailingSlashes(prefix);
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
