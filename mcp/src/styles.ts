import type { HonuaClient } from "@honua/sdk-js";
import { CapabilityUnavailableError } from "./capability.js";

/** Human label for the Honua-only styling surface (capability degradation). */
export const STYLE_SURFACE = "OGC API - Styles";

/**
 * Thin read-only client over the server's OGC API – Styles surface
 * (honua-server, ADR-0048):
 *
 *   GET /ogc/styles                     -> styles list   ({ styles: [{ id, title, links }], default? })
 *   GET /ogc/styles/{styleId}/metadata  -> style metadata ({ id, title, description, keywords, license, version, links })
 *   GET /ogc/styles/{styleId}           -> stylesheet body (MapLibre/Mapbox JSON by default; SLD via Accept)
 *
 * These helpers project the server responses into the geospatial-grpc
 * `StyleRef` / `StyleEncoding` shape (style_id / title / encodings) so the MCP
 * resource + `get_style` tool surface a single canonical style object.
 *
 * The MCP package only consumes the public {@link HonuaClient.pipelineFetch}
 * request pipeline (auth / retry / timeout / interceptors) rather than a
 * private route, matching the other `/ogc/*` consumers in the SDK.
 *
 * @module
 */

/** Default path prefix for the server's OGC API – Styles surface. */
export const OGC_STYLES_PATH = "/ogc/styles";

/** MapLibre / Mapbox style media type (server default stylesheet encoding). */
export const MAPLIBRE_STYLE_MEDIA_TYPE = "application/vnd.mapbox.style+json";

/** SLD 1.0 stylesheet media type. */
export const SLD_10_MEDIA_TYPE = "application/vnd.ogc.sld+xml;version=1.0";

/** SLD 1.1 stylesheet media type. */
export const SLD_11_MEDIA_TYPE = "application/vnd.ogc.sld+xml;version=1.1";

/**
 * Stylesheet encodings the MCP surface understands, keyed by the canonical
 * geospatial-grpc `StyleEncoding.encoding` identifier. The server
 * content-negotiates these via the `Accept` header.
 */
export const STYLE_ENCODINGS = {
  "mapbox-style": MAPLIBRE_STYLE_MEDIA_TYPE,
  "sld-1.0.0": SLD_10_MEDIA_TYPE,
  "sld-1.1.0": SLD_11_MEDIA_TYPE,
} as const;

/** A geospatial-grpc `StyleEncoding`-aligned encoding identifier. */
export type StyleEncodingId = keyof typeof STYLE_ENCODINGS;

/** Hypermedia link entry on an OGC styles document. */
export interface OgcStyleLink {
  href: string;
  rel?: string;
  type?: string;
  title?: string;
}

/** One entry in the `GET /ogc/styles` styles list. */
export interface OgcStyleListEntry {
  id: string;
  title?: string;
  links?: OgcStyleLink[];
}

/** Response body of `GET /ogc/styles`. */
export interface OgcStyleList {
  styles: OgcStyleListEntry[];
  default?: string;
  links?: OgcStyleLink[];
}

/** Response body of `GET /ogc/styles/{styleId}/metadata`. */
export interface OgcStyleMetadata {
  id: string;
  title?: string;
  description?: string;
  keywords?: string[];
  license?: string;
  version?: string;
  links?: OgcStyleLink[];
}

/**
 * A single encoded representation of a style, aligned with the geospatial-grpc
 * `StyleEncoding` message. The MCP surface carries the inline body for the
 * MapLibre encoding (the default the server serves) and exposes the alternate
 * SLD encodings by reference (`storageRef` = the stylesheet URL).
 */
export interface StyleEncoding {
  encoding: StyleEncodingId | string;
  contentType?: string;
  inlineBody?: unknown;
  storageRef?: string;
}

/**
 * Canonical style projection aligned with the geospatial-grpc `StyleRef`
 * message (`style_id` / `title` / `description` / `style_version` /
 * `encodings` / `legend_url`).
 */
export interface StyleRef {
  styleId: string;
  title: string;
  description: string | null;
  styleVersion: number | null;
  legendUrl: string | null;
  encodings: StyleEncoding[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function getJson<T>(client: HonuaClient, path: string, accept: string): Promise<T> {
  let response: Response;
  try {
    response = await client.pipelineFetch("GET", path, { headers: { Accept: accept } });
  } catch (err) {
    // A plain FeatureServer / OGC-Features endpoint has no styling surface, so
    // `GET /ogc/styles*` fails (404, network error, or the SDK's non-2xx throw).
    // Degrade gracefully rather than surfacing a raw crash.
    throw new CapabilityUnavailableError(STYLE_SURFACE, `request to ${path} failed: ${errorMessage(err)}`);
  }
  if (!response.ok) {
    throw new CapabilityUnavailableError(STYLE_SURFACE, `${path} returned HTTP ${response.status}`);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new CapabilityUnavailableError(
      STYLE_SURFACE,
      `${path} did not return JSON (target has no OGC API - Styles surface)`,
    );
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stylePath(styleId: string): string {
  return `${OGC_STYLES_PATH}/${encodeURIComponent(styleId)}`;
}

/** List available styles via `GET /ogc/styles`. */
export async function listStyles(client: HonuaClient): Promise<OgcStyleList> {
  const body = await getJson<unknown>(client, OGC_STYLES_PATH, "application/json");
  if (!isRecord(body) || !Array.isArray(body.styles)) {
    // A well-formed styles document always carries a `styles` array (possibly
    // empty). Anything else means the target is not an OGC API - Styles surface;
    // report that honestly instead of returning a misleading empty catalog.
    throw new CapabilityUnavailableError(STYLE_SURFACE, `${OGC_STYLES_PATH} response is not a styles document`);
  }
  const styles: OgcStyleListEntry[] = [];
  for (const entry of body.styles) {
    if (isRecord(entry) && typeof entry.id === "string") {
      styles.push({
        id: entry.id,
        ...(typeof entry.title === "string" ? { title: entry.title } : {}),
        ...(Array.isArray(entry.links) ? { links: entry.links as OgcStyleLink[] } : {}),
      });
    }
  }
  return {
    styles,
    ...(typeof body.default === "string" ? { default: body.default } : {}),
    ...(Array.isArray(body.links) ? { links: body.links as OgcStyleLink[] } : {}),
  };
}

/** Fetch style metadata via `GET /ogc/styles/{styleId}/metadata`. */
export async function getStyleMetadata(client: HonuaClient, styleId: string): Promise<OgcStyleMetadata> {
  const body = await getJson<OgcStyleMetadata>(client, `${stylePath(styleId)}/metadata`, "application/json");
  return body;
}

/**
 * Fetch the MapLibre/Mapbox stylesheet body via `GET /ogc/styles/{styleId}`
 * (content-negotiated to {@link MAPLIBRE_STYLE_MEDIA_TYPE}).
 */
export async function getMapLibreStylesheet(client: HonuaClient, styleId: string): Promise<unknown> {
  return getJson<unknown>(client, stylePath(styleId), `${MAPLIBRE_STYLE_MEDIA_TYPE}, application/json;q=0.9`);
}

/** Coerce a free-form metadata `version` (string) into the numeric style_version, when possible. */
function parseStyleVersion(version: string | undefined): number | null {
  if (version === undefined) return null;
  const parsed = Number.parseInt(version, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Resolve a single style into a `StyleRef` projection: fetch metadata and the
 * canonical MapLibre stylesheet, and advertise the alternate SLD encodings by
 * reference. The stylesheet base URL (`{baseUrl}/ogc/styles/{styleId}`) backs
 * the `storageRef` for the by-reference encodings.
 */
export async function resolveStyleRef(client: HonuaClient, styleId: string): Promise<StyleRef> {
  const [metadata, maplibre] = await Promise.all([
    getStyleMetadata(client, styleId).catch(() => null),
    getMapLibreStylesheet(client, styleId),
  ]);

  const stylesheetUrl = `${client.serverBaseUrl}${stylePath(styleId)}`;

  const encodings: StyleEncoding[] = [
    {
      encoding: "mapbox-style",
      contentType: MAPLIBRE_STYLE_MEDIA_TYPE,
      inlineBody: maplibre,
    },
    { encoding: "sld-1.0.0", contentType: SLD_10_MEDIA_TYPE, storageRef: stylesheetUrl },
    { encoding: "sld-1.1.0", contentType: SLD_11_MEDIA_TYPE, storageRef: stylesheetUrl },
  ];

  const legendUrl = metadata?.links?.find((l) => l.rel === "preview")?.href ?? null;

  return {
    styleId,
    title: metadata?.title ?? styleId,
    description: metadata?.description ?? null,
    styleVersion: parseStyleVersion(metadata?.version),
    legendUrl,
    encodings,
  };
}
