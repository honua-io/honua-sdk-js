/**
 * Deterministic round-trip fixture inputs for the honua `/mcp` operator surface.
 *
 * Certification calls `tools/call` on read-only operator tools to validate their
 * structured output against the advertised outputSchema. Inputs are resolved
 * from environment overrides so the same harness drives both the offline mock
 * upstream and a live honua-server `/mcp` in remote mode, without ever calling a
 * mutating tool (execute/cancel/publish/propose/create).
 */

export interface RoundTripEnv {
  serviceId: string;
  layerId: number;
  address: string;
  styleId: string | undefined;
  /**
   * Protocol-neutral source reference the source-addressed tools round-trip
   * against (#1005). Defaults to the GeoServices pair so existing targets are
   * unchanged; the non-GeoServices lane overrides it with an OGC collection.
   */
  sourceRef?: string;
  /** Numeric field on `sourceRef` usable for an aggregate round trip. */
  statisticField?: string;
}

/** Resolve round-trip identifiers from the environment, with safe fallbacks. */
export function resolveRoundTripEnv(env: NodeJS.ProcessEnv = process.env): RoundTripEnv {
  const serviceId = env.HONUA_MCP_SERVICE_ID ?? env.HONUA_SERVICE_ID ?? "svc-parks";
  const layerRaw = env.HONUA_MCP_LAYER_ID ?? env.HONUA_LAYER_ID ?? "0";
  const parsedLayer = Number.parseInt(layerRaw, 10);
  const layerId = Number.isFinite(parsedLayer) && parsedLayer >= 0 ? parsedLayer : 0;
  const address = env.HONUA_MCP_ADDRESS ?? "1600 Pennsylvania Ave NW, Washington DC";
  const styleId = env.HONUA_MCP_STYLE_ID ?? env.HONUA_STYLE_ID;
  const sourceRef = env.HONUA_MCP_SOURCE;
  const statisticField = env.HONUA_MCP_STATISTIC_FIELD;
  return {
    serviceId,
    layerId,
    address,
    styleId,
    ...(sourceRef ? { sourceRef } : {}),
    ...(statisticField ? { statisticField } : {}),
  };
}

/**
 * Build the read-only round-trip argument map keyed by advertised tool name.
 * Tools without a fixture entry are still discovered, schema/conformance/output
 * checked, but are not round-tripped (no call is made). Mutating tools are never
 * listed here.
 */
export function buildRoundTripInputs(env: RoundTripEnv): Record<string, Record<string, unknown>> {
  const { serviceId, layerId, address } = env;
  // Source-addressed tools round-trip through the protocol-neutral reference
  // when the target provides one (#1005), and otherwise through the deprecated
  // GeoServices pair — so both addressing modes stay certified.
  const target: Record<string, unknown> = env.sourceRef ? { source: env.sourceRef } : { serviceId, layerId };
  const statisticField = env.statisticField ?? "OBJECTID";
  return {
    // ── Platform-free standalone surface tools (issues #369, #1005). Round-tripped
    // by the `standalone` (Esri FeatureServer) and `standalone-ogc` (OGC API
    // Features) cert targets. The Honua-only style tools resolve to a structured
    // "not available on this target" result (non-error) — certifying graceful
    // degradation, not a crash.
    honua_list_sources: {},
    honua_list_services: {},
    honua_describe_layer: { ...target },
    honua_count_features: { ...target },
    honua_get_extent: { ...target },
    honua_statistics: { ...target, statisticType: "count", onField: statisticField },
    honua_explain_capability_gap: { capability: "query", protocol: "wmts" },
    honua_get_style: {},
    honua_apply_style_preset: { styleId: "topographic" },
    // ── Honua-enhanced operator catalog tools (offline/remote/stdio-proxy targets).
    honua_list_layers: {},
    honua_list_capabilities: {},
    honua_query_features: { ...target, limit: 1 },
    honua_render_map: { layers: [{ serviceId, layerId }], bbox: [-77.1, 38.8, -76.9, 39.0] },
    honua_geocode_address: { address },
    honua_solve_route: {
      stops: [
        { lon: -77.03, lat: 38.9 },
        { lon: -76.61, lat: 39.29 },
      ],
    },
    honua_plan_analysis: { intent: "Count parks within the district boundary" },
    honua_ground_candidates: { goal: "Analyze park coverage" },
    honua_clarify_intent: {
      goal: "Analyze park coverage",
      intentId: "int-001",
      response: { answers: { q1: ["yes"] } },
    },
    honua_validate_plan: { plan: {} },
    honua_dry_run_plan: { plan: { planId: "plan-001", steps: [{ stepId: "s1", kind: "QueryFeatures" }] } },
    honua_resolve_entity: { text: "parks" },
  };
}

/** Target layer for the mutating round-trip + pagination contracts. */
export interface EditTarget {
  serviceId: string;
  layerId: number;
}

/**
 * Resolve the editable/pageable target for the deep contracts. Defaults to the
 * offline mock's seeded `svc-parks` layer 0; override with
 * `HONUA_MCP_EDIT_SERVICE_ID` / `HONUA_MCP_EDIT_LAYER_ID` (or the shared
 * `HONUA_MCP_SERVICE_ID` / `HONUA_MCP_LAYER_ID`) to point a live mutating cert at
 * a dedicated scratch service.
 */
export function resolveEditTarget(env: NodeJS.ProcessEnv = process.env): EditTarget {
  const base = resolveRoundTripEnv(env);
  const serviceId = env.HONUA_MCP_EDIT_SERVICE_ID ?? base.serviceId;
  const layerRaw = env.HONUA_MCP_EDIT_LAYER_ID;
  const parsedLayer = layerRaw !== undefined ? Number.parseInt(layerRaw, 10) : Number.NaN;
  const layerId = Number.isFinite(parsedLayer) && parsedLayer >= 0 ? parsedLayer : base.layerId;
  return { serviceId, layerId };
}

/**
 * A deliberately invalid argument set for the error-shape contract. Certification
 * picks the first advertised tool that has an entry here and calls it with these
 * args, expecting a structured `ValidationFailed` tool result (not a protocol
 * error). `honua_query_features` requires `layerId`, so omitting it is invalid.
 */
export function buildInvalidArgsInputs(): Record<string, Record<string, unknown>> {
  return {
    honua_query_features: { serviceId: "svc-parks" },
    honua_geocode_address: { maxResults: 3 },
    honua_solve_route: { travelProfile: "driving" },
  };
}
