import type { HonuaClient } from "@honua/sdk-js";
import { z } from "zod";
import { jsonText, mapWithConcurrency, metadataErrorText } from "../helpers.js";

/**
 * `honua_list_services` — the GeoServices-specific service catalog.
 *
 * Retained for existing clients; `honua_list_sources` is the protocol-neutral
 * replacement (#1005), because "what services are under /rest/services?" is a
 * question only an Esri endpoint can answer.
 */
export const schema = z.object({
  includeDetails: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Fetch service metadata (description, layer count, spatial reference). Slower due to per-service requests.",
    ),
});

export type Input = z.infer<typeof schema>;

const METADATA_CONCURRENCY = 8;

export async function execute(client: HonuaClient, input: Input) {
  let response: Awaited<ReturnType<HonuaClient["listServices"]>>;
  try {
    response = await client.listServices();
  } catch (err) {
    // Some targets expose no service catalog at `/rest/services` — e.g. a base
    // URL pointed straight at a single FeatureServer, or an OGC-only endpoint.
    // Degrade to a structured note instead of crashing: the agent can still
    // describe/query a known service+layer directly.
    return jsonText({
      catalogAvailable: false,
      services: [],
      reason: `service catalog is not available on this target: ${err instanceof Error ? err.message : String(err)}`,
      guidance:
        "No /rest/services directory here — this tool only sees a GeoServices catalog. Call honua_list_sources, which probes every protocol family this endpoint may publish (OGC API Features included) and returns protocol-neutral source references.",
    });
  }
  const services = (response.services ?? []).filter((s) => s.type === "FeatureServer");

  if (!input.includeDetails) {
    return jsonText(services.map((s) => ({ serviceId: s.name, type: s.type })));
  }

  const detailed = await mapWithConcurrency(services, METADATA_CONCURRENCY, async (s) => {
    try {
      const meta = await client.getFeatureServiceMetadata(s.name);
      return {
        serviceId: s.name,
        type: s.type,
        description: meta.serviceDescription ?? null,
        layerCount: (meta.layers?.length ?? 0) + (meta.tables?.length ?? 0),
        spatialReference: meta.spatialReference ?? null,
        metadataError: null,
      };
    } catch {
      return {
        serviceId: s.name,
        type: s.type,
        description: null,
        layerCount: null,
        spatialReference: null,
        metadataError: metadataErrorText(),
      };
    }
  });

  return jsonText(detailed);
}
