import type { HonuaClient } from "@honua/sdk-js";
import { z } from "zod";
import { CapabilityUnavailableError, capabilityUnavailable } from "../capability.js";
import { jsonText } from "../helpers.js";
import { STYLE_SURFACE, resolveStyleRef } from "../styles.js";

const STYLE_GUIDANCE =
  "This target is a plain FeatureServer/OGC endpoint with no style presets. " +
  "Build a MapLibre style client-side from the layer's fields, or use a Honua deployment for managed presets.";

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
  // `resolveStyleRef` already fetches the MapLibre stylesheet and inlines it on
  // the `mapbox-style` encoding, so reuse that body instead of issuing a second
  // identical GET /ogc/styles/{id}.
  let styleRef: Awaited<ReturnType<typeof resolveStyleRef>>;
  try {
    styleRef = await resolveStyleRef(client, input.styleId);
  } catch (err) {
    if (err instanceof CapabilityUnavailableError) {
      return capabilityUnavailable(STYLE_SURFACE, err.reason, STYLE_GUIDANCE);
    }
    throw err;
  }
  const stylesheet = styleRef.encodings.find((e) => e.encoding === "mapbox-style")?.inlineBody ?? null;

  return jsonText({
    style: styleRef,
    stylesheet,
    application: "client-side",
    note: "Apply this MapLibre stylesheet client-side. MCP does not mutate server state; persisting a preset to a map or service uses the gRPC execution layer.",
  });
}
