import { z } from "zod";
import { GEOMETRY_TYPES, coerceCount, jsonText, mapSpatialRel, resolveGeometryType } from "../helpers.js";
export const schema = z.object({
    serviceId: z.string().describe("The feature service ID"),
    layerId: z.number().int().nonnegative().describe("The layer ID within the service"),
    where: z.string().optional().describe("SQL WHERE clause, e.g. \"status = 'active'\""),
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
export async function execute(client, input) {
    const response = (await client.queryFeatures({
        serviceId: input.serviceId,
        layerId: input.layerId,
        where: input.where,
        geometry: input.geometry,
        geometryType: resolveGeometryType(input.geometry, input.geometryType),
        spatialRel: mapSpatialRel(input.spatialRel),
        returnGeometry: false,
        outFields: "OBJECTID",
        extraParams: { returnCountOnly: true },
    }));
    // The default grpc-web transport returns very large counts as a string to
    // preserve precision beyond Number.MAX_SAFE_INTEGER; accept both forms.
    const count = coerceCount(response.count);
    if (count === undefined) {
        throw new Error("Count query did not return a numeric count.");
    }
    return jsonText({ count });
}
