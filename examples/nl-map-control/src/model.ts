import {
  HonuaAskMapClarification,
  HonuaNlMapControlError,
  type NlCompletionResponse,
  type NlLlmCallback,
} from "@honua/sdk-js/nl-map-control";
import { CRS, SCHEMA } from "./fixture.js";
import { type QueryContext, viewportFilter } from "./query.js";

/** Syntax examples only: models must resolve values from the user's captured context. */
export const SEMANTIC_QUERY_FORMS = {
  features: {
    kind: "features",
    geometry: "omit",
    select: ["id", "status", "kind"],
    page: { kind: "first", limit: 100 },
  },
  aggregate: {
    kind: "aggregate",
    groupBy: ["kind"],
    metrics: [{ fn: "count", as: "count" }],
    page: { kind: "first", limit: 100 },
  },
  filters: {
    comparison: {
      kind: "comparison",
      operator: "eq",
      left: { kind: "property", name: "status" },
      right: { kind: "literal", value: "literal user value" },
    },
    viewport: {
      kind: "spatial",
      operator: "bbox-intersects",
      bbox: { box: { layout: "xy", bounds: [0, 0, 1, 1] }, crs: CRS },
    },
    distance: {
      kind: "spatial",
      operator: "within-distance",
      geometry: { state: "present", layout: "xy", crs: CRS, geometry: { type: "Point", coordinates: [0, 0] } },
      distance: { value: 1, unit: "metre", mode: "planar" },
    },
    polygon: {
      kind: "spatial",
      operator: "intersects",
      geometry: {
        state: "present",
        layout: "xy",
        crs: CRS,
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
              [0, 0],
            ],
          ],
        },
      },
    },
  },
} as const;

export const SUGGESTIONS = [
  "Show open incidents in this view",
  "Group them by type",
  "Only those within 500 metres of this selected location",
  "Show incidents nearby",
  "Show incidents from yesterday",
  "Run arbitrary SQL",
] as const;
export function recordedModel(context: QueryContext): NlLlmCallback {
  return async (request) => {
    let query: unknown;
    switch (request.instruction) {
      case SUGGESTIONS[0]:
        query = {
          kind: "features",
          geometry: "omit",
          select: ["id", "status", "kind"],
          filter: {
            kind: "boolean",
            operator: "and",
            args: [
              {
                kind: "comparison",
                operator: "eq",
                left: { kind: "property", name: "status" },
                right: { kind: "literal", value: "open" },
              },
              viewportFilter(context),
            ],
          },
          page: { kind: "first", limit: 100 },
        };
        break;
      case SUGGESTIONS[1]:
        if (!context.previousQuery)
          throw new HonuaAskMapClarification(
            "Which incidents should be grouped? Execute the first suggested question first.",
          );
        query = {
          kind: "aggregate",
          filter: context.previousQuery.filter,
          groupBy: ["kind"],
          metrics: [{ fn: "count", as: "count" }],
          page: { kind: "first", limit: 100 },
        };
        break;
      case SUGGESTIONS[2]:
        if (!context.selectedLocation)
          throw new HonuaAskMapClarification(
            "Select a location by choosing an incident on the map or in the table, then ask again. Distance is planar EPSG:3857 metres.",
          );
        if (!context.previousQuery?.filter)
          throw new HonuaAskMapClarification("Which incidents should be refined? Execute the first question first.");
        query = {
          ...context.previousQuery,
          filter: {
            kind: "boolean",
            operator: "and",
            args: [
              context.previousQuery.filter,
              {
                kind: "spatial",
                operator: "within-distance",
                geometry: {
                  state: "present",
                  geometry: { type: "Point", coordinates: context.selectedLocation },
                  crs: CRS,
                  layout: "xy",
                },
                distance: { value: 500, unit: "metre", mode: "planar" },
              },
            ],
          },
        };
        break;
      case SUGGESTIONS[3]:
        throw new HonuaAskMapClarification(
          "Select a location and specify a distance and units. Does nearby mean the current view or a distance from that location?",
        );
      case SUGGESTIONS[4]:
        return { refusal: "The admitted source has no date field. A date query is unsupported; no filter changed." };
      case SUGGESTIONS[5]:
        return { refusal: "Arbitrary SQL is unavailable. Supply a schema-grounded structured query." };
      default:
        throw new HonuaNlMapControlError(
          "fixture-mismatch",
          "Recorded mode understands only the exact labelled suggestions. Select live mode for free text.",
        );
    }
    return {
      toolCalls: [
        {
          name: "runWidgetQuery",
          arguments: {
            sourceId: "incidents",
            kind: (query as { kind: string }).kind === "aggregate" ? "categories" : "count",
            semanticQuery: query,
          },
        },
      ],
    } as NlCompletionResponse;
  };
}
export function authenticatedLiveModel(
  endpoint = "/api/ask-map/propose",
  expectedIdentity?: { readonly provider: string; readonly model: string },
): NlLlmCallback {
  return async (request, options) => {
    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: options?.signal,
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(
        `Live model adapter refused the request (${response.status}). Sign in to the configured server-side adapter.`,
      );
    if (!response.body) throw new Error("Live response body is missing.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        options?.signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) {
          await reader.cancel();
          throw new Error("Live response exceeds its bound.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder().decode(bytes);
    const result = JSON.parse(text) as NlCompletionResponse & {
      clarification?: string;
      modelIdentity?: { provider: string; model: string };
    };
    if (
      expectedIdentity &&
      (result.modelIdentity?.provider !== expectedIdentity.provider ||
        result.modelIdentity?.model !== expectedIdentity.model)
    )
      throw new Error("Live adapter model identity does not match the reviewed evaluation configuration.");
    if (result.clarification) throw new HonuaAskMapClarification(result.clarification);
    return result;
  };
}

/** Explicit public fixture grounding preserves CRS authority keys that generic secret-redaction omits. */
export function groundedModel(context: QueryContext, callback: NlLlmCallback): NlLlmCallback {
  return (request, options) =>
    callback(
      {
        ...request,
        system: `${request.system}\nAdmitted public incident schema and captured query context (all coordinates are EPSG:3857):\n${JSON.stringify({ schema: SCHEMA, context })}\nSDK semanticQuery syntax examples, not query defaults or answers:\n${JSON.stringify(SEMANTIC_QUERY_FORMS)}\nChoose a features or aggregate form and put the resolved predicate in its filter property. Combine predicates with {kind:"boolean",operator:"and",args:[predicate,predicate]}. Use runWidgetQuery kind:"count" for features and kind:"categories" for aggregate. Replace every example coordinate, distance and literal with explicitly requested or captured values. Never use example coordinates as a missing selectedLocation. Viewport bounds order is minX,minY,maxX,maxY. Grouping preserves the previous query filter; refinements add to it. A missing location, distance or intended prior query requires clarification. No fixture results or expected answers are provided.`,
      },
      options,
    );
}
