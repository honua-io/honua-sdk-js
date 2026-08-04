import type { HonuaClient } from "@honua/sdk-js";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "@honua/sdk-js/contract";
import { z } from "zod";
import { jsonText, mapWithConcurrency } from "../helpers.js";
import { withCapabilityHonesty } from "../neutral/errors.js";
import { SOURCE_LAYOUTS, type SourceLayout, ogcLayoutFor } from "../neutral/source-ref.js";

/**
 * `honua_list_sources` — protocol-neutral discovery (#1005).
 *
 * `honua_list_services` answers a GeoServices-only question ("what is in
 * `/rest/services`?"). This tool answers the neutral one — "what sources can I
 * query here, and how do I address them?" — and emits the exact
 * `<protocol>:<address>` references every other tool accepts, so an agent never
 * has to construct one.
 *
 * Each protocol family is probed independently and degrades on its own: an
 * endpoint that serves OGC collections but has no `/rest/services` directory
 * reports the GeoServices family as unavailable-with-reason and still returns
 * its OGC sources. A family that is absent is never reported as "no sources".
 */
export const schema = z.object({
  protocol: z
    .enum(["auto", "geoservices", "ogc-features", "ogc-records"])
    .optional()
    .default("auto")
    .describe("Restrict discovery to one protocol family. `auto` (default) probes every family this server can list."),
  layout: z
    .enum(SOURCE_LAYOUTS)
    .optional()
    .describe(
      'Endpoint layout for the OGC families: "honua-facade" (default) or "ogc-api"/"auto" for a third-party OGC API root.',
    ),
  maxServices: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .default(25)
    .describe("Maximum GeoServices services expanded into per-layer sources (each costs one metadata request)."),
});

export type Input = z.infer<typeof schema>;

const METADATA_CONCURRENCY = 8;

interface DiscoveredSource {
  source: string;
  protocol: string;
  title: string | null;
  capabilities: string[];
}

interface FamilyOutcome {
  available: boolean;
  reason?: string;
  sources: DiscoveredSource[];
}

function capabilitiesFor(protocol: keyof typeof PROTOCOL_DEFAULT_CAPABILITIES): string[] {
  return [...PROTOCOL_DEFAULT_CAPABILITIES[protocol]].sort();
}

async function discoverGeoServices(client: HonuaClient, maxServices: number): Promise<FamilyOutcome> {
  let response: Awaited<ReturnType<HonuaClient["listServices"]>>;
  try {
    response = await client.listServices();
  } catch (err) {
    return {
      available: false,
      reason: `no GeoServices catalog on this target: ${err instanceof Error ? err.message : String(err)}`,
      sources: [],
    };
  }

  const services = (response.services ?? []).filter((s) => s.type === "FeatureServer" || s.type === "MapServer");
  const expanded = services.slice(0, maxServices);
  const perService = await mapWithConcurrency(expanded, METADATA_CONCURRENCY, async (service) => {
    const protocol = service.type === "MapServer" ? "geoservices-map-service" : "geoservices-feature-service";
    try {
      const meta = await client.getFeatureServiceMetadata(service.name);
      const layers = [...(meta.layers ?? []), ...(meta.tables ?? [])];
      return layers.map((layer) => ({
        source: `${protocol}:${service.name}/${layer.id}`,
        protocol,
        title: layer.name ?? null,
        capabilities: capabilitiesFor(protocol),
      }));
    } catch {
      // The service exists but its metadata is unreadable; still emit the
      // conventional layer-0 reference rather than dropping the service.
      return [
        {
          source: `${protocol}:${service.name}/0`,
          protocol,
          title: service.name,
          capabilities: capabilitiesFor(protocol),
        },
      ];
    }
  });

  return { available: true, sources: perService.flat() };
}

async function discoverOgc(
  client: HonuaClient,
  family: "ogc-features" | "ogc-records",
  layout: SourceLayout | undefined,
): Promise<FamilyOutcome> {
  try {
    const resolved = await ogcLayoutFor(client, layout);
    const request = resolved ? { layout: resolved } : {};
    const response =
      family === "ogc-records"
        ? await client.listOgcRecordCollections(request)
        : await client.listOgcCollections(request);
    return {
      available: true,
      sources: (response.collections ?? []).map((collection) => ({
        source: `${family}:${collection.id}`,
        protocol: family,
        title: collection.title ?? collection.id,
        capabilities: capabilitiesFor(family),
      })),
    };
  } catch (err) {
    return {
      available: false,
      reason: `no ${family} collections on this target: ${err instanceof Error ? err.message : String(err)}`,
      sources: [],
    };
  }
}

export async function execute(client: HonuaClient, input: Input) {
  return withCapabilityHonesty(async () => {
    const families: Record<string, FamilyOutcome> = {};

    if (input.protocol === "auto" || input.protocol === "geoservices") {
      families.geoservices = await discoverGeoServices(client, input.maxServices);
    }
    if (input.protocol === "auto" || input.protocol === "ogc-features") {
      families["ogc-features"] = await discoverOgc(client, "ogc-features", input.layout);
    }
    if (input.protocol === "ogc-records") {
      families["ogc-records"] = await discoverOgc(client, "ogc-records", input.layout);
    }

    const sources = Object.values(families).flatMap((family) => family.sources);
    return jsonText({
      sources,
      sourceCount: sources.length,
      families: Object.fromEntries(
        Object.entries(families).map(([name, outcome]) => [
          name,
          {
            available: outcome.available,
            ...(outcome.reason ? { reason: outcome.reason } : {}),
            count: outcome.sources.length,
          },
        ]),
      ),
      guidance:
        sources.length > 0
          ? "Pass a `source` value verbatim to honua_describe_layer / honua_query_features / honua_count_features / honua_get_extent / honua_statistics."
          : 'No source catalog is published here. Address a known source directly, e.g. source="ogc-features:<collectionId>", "stac:<collectionId>", "wfs:<typeName>", "odata:<entitySet>", or "geoservices-feature-service:<serviceId>/<layerId>".',
    });
  });
}
