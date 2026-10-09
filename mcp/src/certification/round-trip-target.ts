import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RoundTripEnv } from "./fixtures.js";

/**
 * Round-trip target discovery for a freshly booted candidate.
 *
 * The read-only round trips need a published layer. The offline mock seeds
 * `svc-parks`, but a fresh `honua admin install local` candidate publishes
 * nothing under that id. Setting `HONUA_MCP_SERVICE_ID=discover` makes the
 * certifier ask the candidate itself (`honua_list_layers`) and bind the round
 * trips to the first published layer. When the candidate serves no layer the
 * `round-trip-target` contract is `blocked`: the evidence could not be gathered,
 * so the summary cannot pass, and the service-bound tools are not called with a
 * made-up id.
 */

/** Sentinel value of `HONUA_MCP_SERVICE_ID` that asks for discovery. */
export const DISCOVER_SERVICE_ID = "discover";

/** The tool the target is discovered from. */
export const LIST_LAYERS_TOOL = "honua_list_layers";

/** Round-trip fixtures that address a published service/layer. */
export const SERVICE_BOUND_TOOLS: readonly string[] = [
  "honua_describe_layer",
  "honua_count_features",
  "honua_get_extent",
  "honua_statistics",
  "honua_query_features",
  "honua_render_map",
];

export type RoundTripTargetResolution =
  | { status: "passed"; serviceId: string; layerId: number; detail: string }
  | { status: "blocked"; detail: string };

/** Whether the resolved round-trip env asks for discovery. */
export function wantsDiscovery(env: RoundTripEnv): boolean {
  return env.serviceId === DISCOVER_SERVICE_ID;
}

function asLayerId(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : undefined;
}

function asServiceId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Pick the first published layer from a `honua_list_layers` payload
 * (`structuredContent`, or the JSON text content when no structured output is
 * returned). Accepts camelCase and snake_case identifiers.
 */
export function firstPublishedLayer(payload: unknown): { serviceId: string; layerId: number } | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const layers = (payload as { layers?: unknown }).layers;
  if (!Array.isArray(layers)) {
    return undefined;
  }
  for (const layer of layers) {
    if (!layer || typeof layer !== "object") {
      continue;
    }
    const l = layer as Record<string, unknown>;
    const serviceId = asServiceId(l.serviceId ?? l.service_id);
    const layerId = asLayerId(l.layerId ?? l.layer_id);
    if (serviceId && layerId !== undefined) {
      return { serviceId, layerId };
    }
  }
  return undefined;
}

function payloadOf(result: { structuredContent?: unknown; content?: unknown }): unknown {
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  if (Array.isArray(result.content)) {
    for (const part of result.content) {
      const text =
        (part as { type?: string; text?: unknown }).type === "text" ? (part as { text?: unknown }).text : undefined;
      if (typeof text === "string") {
        try {
          return JSON.parse(text);
        } catch {
          // not JSON; keep looking
        }
      }
    }
  }
  return undefined;
}

/** Ask the candidate for its first published layer. Never throws. */
export async function discoverRoundTripTarget(
  client: Pick<Client, "callTool">,
  advertisedNames: Set<string>,
): Promise<RoundTripTargetResolution> {
  if (!advertisedNames.has(LIST_LAYERS_TOOL)) {
    return {
      status: "blocked",
      detail: `${LIST_LAYERS_TOOL} is not advertised, so no published layer can be discovered`,
    };
  }
  try {
    const result = (await client.callTool({ name: LIST_LAYERS_TOOL, arguments: {} })) as {
      isError?: boolean;
      structuredContent?: unknown;
      content?: unknown;
    };
    if (result.isError) {
      return { status: "blocked", detail: `${LIST_LAYERS_TOOL} returned isError=true; no published layer discovered` };
    }
    const layer = firstPublishedLayer(payloadOf(result));
    if (!layer) {
      return {
        status: "blocked",
        detail: `the candidate serves no published layer (${LIST_LAYERS_TOOL} returned none); publish a service before certifying the round trips`,
      };
    }
    return {
      status: "passed",
      ...layer,
      detail: `round trips bound to ${layer.serviceId} layer ${layer.layerId} (first layer from ${LIST_LAYERS_TOOL})`,
    };
  } catch (err) {
    return {
      status: "blocked",
      detail: `${LIST_LAYERS_TOOL} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Drop the round-trip fixtures that would address an undiscovered service. */
export function withoutServiceBoundInputs(
  inputs: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const kept = { ...inputs };
  for (const name of SERVICE_BOUND_TOOLS) {
    delete kept[name];
  }
  return kept;
}
