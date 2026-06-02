import type { HonuaClient } from "@honua/sdk-js";
import { z } from "zod";
import { jsonText } from "../helpers.js";
import { listStyles, resolveStyleRef } from "../styles.js";

export const schema = z.object({
  styleId: z.string().optional().describe("Stable style identifier. Omit to list the styles available on the server."),
});

export type Input = z.infer<typeof schema>;

/**
 * Resolve a style from the server's OGC API – Styles surface. With a `styleId`,
 * returns the canonical `StyleRef` projection (style_id / title / description /
 * style_version / encodings / legend_url), with the MapLibre stylesheet inlined.
 * Without a `styleId`, returns the styles catalog so an agent can discover what
 * is available.
 */
export async function execute(client: HonuaClient, input: Input) {
  if (!input.styleId) {
    const list = await listStyles(client);
    return jsonText({
      styles: list.styles.map((entry) => ({
        styleId: entry.id,
        title: entry.title ?? entry.id,
        uri: `honua://styles/${encodeURIComponent(entry.id)}`,
      })),
      default: list.default ?? null,
    });
  }

  const styleRef = await resolveStyleRef(client, input.styleId);
  return jsonText(styleRef);
}
