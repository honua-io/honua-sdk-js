/**
 * Deterministic round-trip fixture inputs for read-only tools.
 *
 * Certification calls `tools/call` only for tools the server marks read-only
 * (see `isReadOnlyTool`). The inputs below are resolved from environment
 * overrides so the same harness drives both the offline fixture backend (tests)
 * and a live honua-server in CI, without ever calling a write/destructive tool.
 */

export interface RoundTripEnv {
  serviceId: string;
  layerId: number;
  styleId: string | undefined;
}

/** Resolve round-trip identifiers from the environment, with safe fallbacks. */
export function resolveRoundTripEnv(env: NodeJS.ProcessEnv = process.env): RoundTripEnv {
  const serviceId = env.HONUA_MCP_SERVICE_ID ?? env.HONUA_SERVICE_ID ?? "Parks";
  const layerRaw = env.HONUA_MCP_LAYER_ID ?? env.HONUA_LAYER_ID ?? "0";
  const parsedLayer = Number.parseInt(layerRaw, 10);
  const layerId = Number.isFinite(parsedLayer) && parsedLayer >= 0 ? parsedLayer : 0;
  const styleId = env.HONUA_MCP_STYLE_ID ?? env.HONUA_STYLE_ID;
  return { serviceId, layerId, styleId };
}

/**
 * Build the fixture argument map keyed by advertised tool name. Tools without a
 * fixture entry are still discovered and schema/conformance checked, but are not
 * round-tripped (no call is made).
 */
export function buildRoundTripInputs(env: RoundTripEnv): Record<string, Record<string, unknown>> {
  const { serviceId, layerId } = env;
  const styleId = env.styleId;
  return {
    honua_list_services: {},
    honua_describe_layer: { serviceId, layerId },
    honua_query_features: { serviceId, layerId, limit: 1 },
    honua_count_features: { serviceId, layerId },
    honua_get_extent: { serviceId, layerId },
    honua_statistics: { serviceId, layerId, statisticType: "count", onField: "OBJECTID" },
    honua_explain_capability_gap: { protocol: "wmts", capability: "query" },
    honua_get_style: styleId ? { styleId } : {},
    honua_apply_style_preset: styleId ? { styleId } : { styleId: "topographic" },
  };
}
