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
}

/** Resolve round-trip identifiers from the environment, with safe fallbacks. */
export function resolveRoundTripEnv(env: NodeJS.ProcessEnv = process.env): RoundTripEnv {
  const serviceId = env.HONUA_MCP_SERVICE_ID ?? env.HONUA_SERVICE_ID ?? "svc-parks";
  const layerRaw = env.HONUA_MCP_LAYER_ID ?? env.HONUA_LAYER_ID ?? "0";
  const parsedLayer = Number.parseInt(layerRaw, 10);
  const layerId = Number.isFinite(parsedLayer) && parsedLayer >= 0 ? parsedLayer : 0;
  const address = env.HONUA_MCP_ADDRESS ?? "1600 Pennsylvania Ave NW, Washington DC";
  const styleId = env.HONUA_MCP_STYLE_ID ?? env.HONUA_STYLE_ID;
  return { serviceId, layerId, address, styleId };
}

/**
 * Build the read-only round-trip argument map keyed by advertised tool name.
 * Tools without a fixture entry are still discovered, schema/conformance/output
 * checked, but are not round-tripped (no call is made). Mutating tools are never
 * listed here.
 */
export function buildRoundTripInputs(env: RoundTripEnv): Record<string, Record<string, unknown>> {
  const { serviceId, layerId, address } = env;
  return {
    honua_list_layers: {},
    honua_list_capabilities: {},
    honua_query_features: { serviceId, layerId, limit: 1 },
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
