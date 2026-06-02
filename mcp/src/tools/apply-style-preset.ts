import type { HonuaClient } from "@honua/sdk-js";
import { z } from "zod";
import { jsonText } from "../helpers.js";
import { getMapLibreStylesheet, resolveStyleRef } from "../styles.js";

export const schema = z.object({
  styleId: z.string().describe("Stable style identifier of the preset to resolve."),
});

export type Input = z.infer<typeof schema>;

/**
 * Resolve a style preset for client-side application. Returns the canonical
 * `StyleRef` plus the MapLibre/Mapbox stylesheet body so an agent or downstream
 * runtime can apply the preset to a map.
 *
 * This is a read-only inspection projection: it resolves and returns the
 * preset's stylesheet but never mutates server state. Persisting a preset onto
 * a map or published service stays with the typed gRPC execution layer per the
 * MCP boundary (geospatial-mcp taxonomy / ADR-0028).
 */
export async function execute(client: HonuaClient, input: Input) {
  const [styleRef, stylesheet] = await Promise.all([
    resolveStyleRef(client, input.styleId),
    getMapLibreStylesheet(client, input.styleId),
  ]);

  return jsonText({
    style: styleRef,
    stylesheet,
    application: "client-side",
    note: "Apply this MapLibre stylesheet client-side. MCP does not mutate server state; persisting a preset to a map or service uses the gRPC execution layer.",
  });
}
