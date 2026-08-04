import type { HonuaClient } from "@honua/sdk-js";
import { z } from "zod";
import { jsonText } from "../helpers.js";
import { withCapabilityHonesty } from "../neutral/errors.js";
import { queryFilterFields, queryShapeFields, toQuery } from "../neutral/query.js";
import { projectDegraded, projectFeatures } from "../neutral/result.js";
import { resolveSource, sourceRefFields } from "../neutral/source-ref.js";

/**
 * `honua_query_features` — protocol-neutral feature read (#1005).
 *
 * Addresses a source by its neutral `<protocol>:<address>` reference, filters
 * with the typed semantic filter / GeoJSON geometry / canonical temporal
 * predicate, and executes through the SDK's canonical `Source.query()`, so the
 * same call means the same thing against GeoServices, OGC API Features, STAC,
 * WFS, and OData. The deprecated `serviceId` + `layerId` pair is still accepted.
 */
export const schema = z.object({
  ...sourceRefFields,
  ...queryFilterFields,
  ...queryShapeFields,
});

export type Input = z.infer<typeof schema>;

export async function execute(client: HonuaClient, input: Input) {
  return withCapabilityHonesty(async () => {
    const resolved = resolveSource(client, input);
    const query = toQuery(input, { protocol: resolved.descriptor.protocol });
    const result = await resolved.source.query(query);

    // Legacy addressing keeps legacy output: a client that still sends
    // serviceId/layerId also still expects Esri-JSON geometry. Neutral
    // addressing gets the neutral encoding.
    const geometryFormat = input.geometryFormat ?? (resolved.legacyAddressing ? "esri-json" : "geojson");
    const returnGeometry = input.returnGeometry ?? false;
    const degraded = projectDegraded(result.degraded);

    return jsonText({
      source: resolved.ref.ref,
      protocol: resolved.descriptor.protocol,
      returnedCount: result.features.length,
      features: projectFeatures(result, { returnGeometry, geometryFormat }),
      geometryFormat: returnGeometry ? geometryFormat : null,
      exceededTransferLimit: result.exceededTransferLimit,
      totalCount: result.totalCount ?? null,
      fields: result.fields ?? null,
      ...(degraded ? { degraded } : {}),
    });
  });
}
