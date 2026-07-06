import type { HonuaClient } from "@honua/sdk-js";
import { CapabilityUnavailableError, capabilityUnavailablePayload } from "../capability.js";
import { STYLE_SURFACE, listStyles, resolveStyleRef } from "../styles.js";

const STYLE_GUIDANCE =
  "This target is a plain FeatureServer/OGC endpoint with no OGC API - Styles surface. " +
  "Build a MapLibre style client-side, or point honua-mcp at a Honua deployment for managed styles.";

/** URI for the styles catalog resource (`honua://styles`). */
export const uri = "honua://styles";

/** URI template for a single style resource (`honua://styles/{styleId}`). */
export const uriTemplate = "honua://styles/{styleId}";

/**
 * Read the styles catalog: the list of styles available on the server, each
 * with its stable styleId, title, and canonical URI (`honua://styles/{id}`).
 */
export async function readCatalog(client: HonuaClient) {
  let list: Awaited<ReturnType<typeof listStyles>>;
  try {
    list = await listStyles(client);
  } catch (err) {
    if (err instanceof CapabilityUnavailableError) {
      return unavailableContents(uri, err.reason);
    }
    throw err;
  }
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

/** Structured "not available on this target" resource body (platform-free mode). */
function unavailableContents(resourceUri: string, reason: string) {
  return {
    contents: [
      {
        uri: resourceUri,
        mimeType: "application/json" as const,
        text: JSON.stringify(capabilityUnavailablePayload(STYLE_SURFACE, reason, STYLE_GUIDANCE), null, 2),
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
  let styleRef: Awaited<ReturnType<typeof resolveStyleRef>>;
  try {
    styleRef = await resolveStyleRef(client, styleId);
  } catch (err) {
    if (err instanceof CapabilityUnavailableError) {
      return unavailableContents(`honua://styles/${encodeURIComponent(styleId)}`, err.reason);
    }
    throw err;
  }

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
