import { isSafeBrowserTileEndpoint } from "./core/browser-tile-endpoint.js";
/** Internal discovery of native renderer templates from advertised OGC links. */
import type { HonuaClient } from "./core/client.js";
import { HonuaAbortError } from "./core/errors.js";
import { isOgcVectorTileTemplate } from "./core/ogc-vector-tile-template.js";
import type {
  HonuaOgcCollectionSummary,
  HonuaOgcLink,
  HonuaOgcTilesetMetadata,
  HonuaOgcTilesetsResponse,
} from "./core/types.js";

export async function discoverOgcVectorTemplate(
  client: HonuaClient,
  collection: HonuaOgcCollectionSummary,
  options: { basePath: string; signal?: AbortSignal },
): Promise<string | undefined> {
  const link = jsonLink(collection.links, "http://www.opengis.net/def/rel/ogc/1.0/tilesets-vector");
  if (!link) return undefined;
  const collectionUrl = `${client.serverBaseUrl}${options.basePath}/collections/${encodeURIComponent(collection.id)}`;
  try {
    const listUrl = metadataUrl(link.href, collectionUrl);
    if (!listUrl) return undefined;
    const list = await client.pipelineRequestJson<HonuaOgcTilesetsResponse>(
      "GET",
      listUrl.pathname + listUrl.search,
      undefined,
      options.signal,
    );
    for (const summary of list.tilesets ?? []) {
      if (!isWebMercatorVector(summary)) continue;
      const template = await resolveTilesetTemplate(client, summary, { listUrl, signal: options.signal });
      if (template) return template;
    }
  } catch (error) {
    if (options.signal?.aborted || error instanceof HonuaAbortError)
      throw new HonuaAbortError("OGC tile discovery aborted.");
    // Optional renderer metadata must not prevent access to other collections.
  }
  return undefined;
}

async function resolveTilesetTemplate(
  client: HonuaClient,
  summary: HonuaOgcTilesetMetadata,
  options: { listUrl: URL; signal?: AbortSignal },
): Promise<string | undefined> {
  try {
    const direct = itemTemplate(summary, options.listUrl.href);
    if (direct) return direct;
    const link = jsonLink(summary.links, "self");
    const detailUrl = link && metadataUrl(link.href, options.listUrl.href);
    if (!detailUrl) return undefined;
    const detail = await client.pipelineRequestJson<HonuaOgcTilesetMetadata>(
      "GET",
      detailUrl.pathname + detailUrl.search,
      undefined,
      options.signal,
    );
    return isWebMercatorVector(detail) ? itemTemplate(detail, detailUrl.href) : undefined;
  } catch (error) {
    if (options.signal?.aborted || error instanceof HonuaAbortError)
      throw new HonuaAbortError("OGC tile discovery aborted.");
    return undefined;
  }
}

function jsonLink(links: HonuaOgcLink[] | undefined, relation: string): HonuaOgcLink | undefined {
  const candidates = links?.filter((entry) => entry.rel === relation);
  return (
    candidates?.find((entry) => entry.type?.split(";")[0]?.trim().toLowerCase() === "application/json") ??
    candidates?.find((entry) => !entry.type)
  );
}

function metadataUrl(href: string, base: string): URL | undefined {
  const url = new URL(href, base);
  // Requests reuse the authenticated client pipeline only on its own origin.
  return url.origin === new URL(base).origin && isSafeBrowserTileEndpoint(url.href) ? url : undefined;
}

function isWebMercatorVector(tileset: HonuaOgcTilesetMetadata): boolean {
  return (
    tileset.dataType === "vector" &&
    (tileset.tileMatrixSetId === "WebMercatorQuad" ||
      tileset.tileMatrixSetURI === "http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad")
  );
}

function itemTemplate(tileset: HonuaOgcTilesetMetadata, base: string): string | undefined {
  for (const link of tileset.links ?? []) {
    if (
      link.rel !== "item" ||
      !["application/vnd.mapbox-vector-tile", "application/x-protobuf"].includes(link.type ?? "")
    )
      continue;
    try {
      const template = new URL(link.href, base).href
        .replaceAll(/%7B/gi, "{")
        .replaceAll(/%7D/gi, "}")
        .replaceAll("{tileMatrix}", "{z}")
        .replaceAll("{tileRow}", "{y}")
        .replaceAll("{tileCol}", "{x}");
      if (isOgcVectorTileTemplate(template)) return template;
    } catch {
      /* Malformed item links cannot become renderer requests. */
    }
  }
  return undefined;
}
