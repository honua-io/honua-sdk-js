import type { HonuaClient } from "@honua/sdk-js";
import { z } from "zod";
import { GEOMETRY_TYPES, coerceCount, jsonText, mapSpatialRel, resolveGeometryType } from "../helpers.js";

export const schema = z.object({
  serviceId: z.string().describe("The feature service ID"),
  layerId: z.number().int().nonnegative().describe("The layer ID within the service"),
  where: z.string().optional().describe("SQL WHERE clause"),
  geometry: z.record(z.unknown()).optional().describe("Esri JSON geometry for spatial filter"),
  geometryType: z
    .enum(GEOMETRY_TYPES)
    .optional()
    .describe("Esri geometry type. If omitted, inferred from geometry when possible."),
  spatialRel: z
    .enum(["intersects", "contains", "within"])
    .optional()
    .describe("Spatial relationship (default: intersects)"),
});

export type Input = z.infer<typeof schema>;

export async function execute(client: HonuaClient, input: Input) {
  const response = (await client.queryFeatures({
    serviceId: input.serviceId,
    layerId: input.layerId,
    where: input.where,
    geometry: input.geometry,
    geometryType: resolveGeometryType(input.geometry, input.geometryType),
    spatialRel: mapSpatialRel(input.spatialRel),
    returnGeometry: false,
    extraParams: { returnExtentOnly: true },
  })) as Record<string, unknown>;

  // Accept large counts returned as strings by the grpc-web transport (chosen
  // to preserve precision beyond Number.MAX_SAFE_INTEGER) as well as numbers.
  const count = coerceCount(response.count);

  const hasExtent = Object.prototype.hasOwnProperty.call(response, "extent");
  if (!hasExtent) {
    // Some backends can return count-only payloads for empty extent queries.
    if (count !== undefined) {
      return jsonText({ extent: null, count });
    }
    throw new Error("Extent query did not return an extent payload.");
  }

  let extent: Record<string, unknown> | null;
  if (response.extent === null) {
    extent = null;
  } else if (typeof response.extent === "object" && !Array.isArray(response.extent)) {
    // A JSON array is `typeof "object"` but is not a valid extent envelope.
    extent = response.extent as Record<string, unknown>;
  } else {
    throw new Error("Extent query returned an invalid extent payload.");
  }

  return jsonText({ extent, count });
}
