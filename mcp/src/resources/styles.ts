import type { HonuaClient } from "@honua/sdk-js";
import { listStyles, resolveStyleRef } from "../styles.js";

/** URI for the styles catalog resource (`honua://styles`). */
export const uri = "honua://styles";

/** URI template for a single style resource (`honua://styles/{styleId}`). */
export const uriTemplate = "honua://styles/{styleId}";

/**
 * Read the styles catalog: the list of styles available on the server, each
 * with its stable styleId, title, and canonical URI (`honua://styles/{id}`).
 */
export async function readCatalog(client: HonuaClient) {
  const list = await listStyles(client);
  const styles = list.styles.map((entry) => ({
    styleId: entry.id,
    title: entry.title ?? entry.id,
    uri: `honua://styles/${encodeURIComponent(entry.id)}`,
  }));

  return {
    contents: [
      {
        uri,
        mimeType: "application/json" as const,
        text: JSON.stringify({ styles, default: list.default ?? null }, null, 2),
      },
    ],
  };
}

/**
 * Read a single style as a `StyleRef` projection (style_id / title /
 * description / style_version / encodings / legend_url), resolved against the
 * server's `/ogc/styles/{styleId}` surface.
 */
export async function read(client: HonuaClient, styleId: string) {
  const styleRef = await resolveStyleRef(client, styleId);

  return {
    contents: [
      {
        uri: `honua://styles/${encodeURIComponent(styleId)}`,
        mimeType: "application/json" as const,
        text: JSON.stringify(styleRef, null, 2),
      },
    ],
  };
}
