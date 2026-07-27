import {
  type HonuaKernelConnection,
  type Query,
  type QueryExecutionPlanV1,
  type Source,
  explainQuery,
  isHonuaError,
} from "@honua/sdk-js";
import { type AutomaticMapLibrePlan, explainAutomaticSourceToMapLibre } from "@honua/sdk-js/map";

import type { ServiceExplorerReadyState, ServiceExplorerSourceView } from "./truth-model.js";

export const SERVICE_EXPLORER_DEFAULT_LIMIT = 25;
export const SERVICE_EXPLORER_MAX_LIMIT = 100;
export const SERVICE_EXPLORER_OPERATION_TIMEOUT_MS = 10_000;

export type ServiceExplorerOperationId = "query" | "render";

export interface ServiceExplorerActionDecision {
  readonly id: ServiceExplorerOperationId;
  readonly capability: "query" | "render";
  readonly enabled: boolean;
  readonly code: string;
  readonly reason: string;
}

export interface ServiceExplorerOperationProjection {
  readonly sourceId?: string;
  readonly source?: Source<Record<string, unknown>>;
  readonly query: Readonly<Query<Record<string, unknown>>>;
  readonly queryPlan?: QueryExecutionPlanV1;
  readonly renderPlan?: AutomaticMapLibrePlan;
  readonly actions: Readonly<Record<ServiceExplorerOperationId, ServiceExplorerActionDecision>>;
}

/**
 * Project public capability decisions through the real query and MapLibre
 * planners. An action is enabled only when endpoint evidence and the accepting
 * planner both agree; this layer never invents protocol support.
 */
export function projectServiceExplorerOperations(
  state: ServiceExplorerReadyState,
  connection: HonuaKernelConnection,
  requestedLimit: number = SERVICE_EXPLORER_DEFAULT_LIMIT,
): ServiceExplorerOperationProjection {
  const limit = validLimit(requestedLimit);
  const query: Readonly<Query<Record<string, unknown>>> = deepFreeze({
    pagination: { limit: limit ?? SERVICE_EXPLORER_DEFAULT_LIMIT },
    returnGeometry: true,
  });
  const selected = selectedSource(state);
  if (!selected) {
    return projectionWithoutSource(query, "source.selection-required", "Choose an inspected source first.");
  }

  let source: Source<Record<string, unknown>>;
  try {
    source = connection.source(selected.id);
  } catch {
    return projectionWithoutSource(
      query,
      "source.unavailable",
      "The inspected source handle is no longer available. Inspect the endpoint again.",
      selected.id,
    );
  }

  const queryCapability = capabilityDecision(selected, "query");
  let queryPlan: QueryExecutionPlanV1 | undefined;
  let queryAction: ServiceExplorerActionDecision;
  if (limit === undefined) {
    queryAction = action(
      "query",
      false,
      "input.invalid-limit",
      `Limit must be a whole number from 1 to ${SERVICE_EXPLORER_MAX_LIMIT}.`,
    );
  } else if (!queryCapability?.effective) {
    queryAction = capabilityAction("query", queryCapability);
  } else {
    try {
      queryPlan = explainQuery({ descriptor: source.descriptor, query, capabilityPolicy: "strict" });
      queryAction = action(
        "query",
        true,
        "planner.accepted",
        "Endpoint evidence and the strict query planner accept this bounded query.",
      );
    } catch (error) {
      queryAction = action(
        "query",
        false,
        errorCode(error, "planner.rejected"),
        "The strict query planner rejected this source and query combination.",
      );
    }
  }

  const renderCapability = capabilityDecision(selected, "render");
  let renderPlan: AutomaticMapLibrePlan | undefined;
  let renderAction: ServiceExplorerActionDecision;
  if (!renderCapability?.effective) {
    renderAction = capabilityAction("render", renderCapability);
  } else {
    try {
      renderPlan = explainAutomaticSourceToMapLibre(source, {
        ...(queryPlan ? { queryPlan } : {}),
        sourceId: "service-explorer-source",
        layerId: "service-explorer-layer",
      });
      const selectedStrategy = renderPlan.selected;
      renderAction = selectedStrategy
        ? action(
            "render",
            true,
            "map-planner.accepted",
            `The MapLibre planner accepted the exact ${selectedStrategy.strategy} strategy.`,
          )
        : action(
            "render",
            false,
            `map-planner.${renderPlan.diagnostics[0]?.code ?? "no-eligible-strategy"}`,
            "The source advertises render support, but no exact MapLibre strategy has enough inspected metadata.",
          );
    } catch (error) {
      renderAction = action(
        "render",
        false,
        errorCode(error, "map-planner.rejected"),
        "The MapLibre planner rejected this inspected source.",
      );
    }
  }

  return Object.freeze({
    sourceId: selected.id,
    source,
    query,
    ...(queryPlan ? { queryPlan } : {}),
    ...(renderPlan ? { renderPlan } : {}),
    actions: Object.freeze({ query: queryAction, render: renderAction }),
  });
}

export function generateServiceExplorerCode(
  state: ServiceExplorerReadyState,
  projection: ServiceExplorerOperationProjection,
  operation: ServiceExplorerOperationId,
): string {
  const sourceId = projection.sourceId;
  if (!sourceId) return "// Inspect an endpoint and choose a source before generating code.";
  const endpoint = JSON.stringify(state.request.endpoint);
  const protocol = JSON.stringify(state.inspection.service.protocol);
  const source = JSON.stringify(sourceId);
  const query = JSON.stringify(projection.query, null, 2);
  const usesQueryPlan = operation === "query" || projection.renderPlan?.selected?.strategy === "geojson-query";
  const acceptedQuery = `const query = ${query};\nconst queryPlan = explainQuery({ descriptor: source.descriptor, query, capabilityPolicy: "strict" });`;
  const operationBody =
    operation === "query"
      ? `const signal = AbortSignal.timeout(${SERVICE_EXPLORER_OPERATION_TIMEOUT_MS});\n${acceptedQuery}\nconst execution = await executeQueryPlan(queryPlan, source, { signal });\nconsole.log(execution.result.features);`
      : `const signal = AbortSignal.timeout(${SERVICE_EXPLORER_OPERATION_TIMEOUT_MS});\nconst map = new maplibregl.Map({ container: "map", style: { version: 8, sources: {}, layers: [] } });\ntry {\n  await new Promise<void>((resolve) => map.once("load", () => resolve()));\n${usesQueryPlan ? `${indent(acceptedQuery, 2)}\n` : ""}  const renderPlan = explainAutomaticSourceToMapLibre(source, {${usesQueryPlan ? " queryPlan" : ""} });\n  if (!renderPlan.selected) throw new Error("No exact MapLibre strategy was accepted");\n  const mounted = await mountAutomaticSourceToMapLibre(map, source, renderPlan, {${usesQueryPlan ? " queryPlan," : ""} signal });\n  try {\n    await mounted.ready;\n    console.log(renderPlan.selected.strategy);\n  } finally {\n    mounted.dispose();\n  }\n} finally {\n  map.remove();\n}`;
  const rootImports = ["createHonua"];
  if (operation === "query") rootImports.push("executeQueryPlan");
  if (usesQueryPlan) rootImports.push("explainQuery");
  const imports =
    operation === "query"
      ? `import { ${rootImports.join(", ")} } from "@honua/sdk-js";`
      : `import "maplibre-gl/dist/maplibre-gl.css";\nimport { ${rootImports.join(", ")} } from "@honua/sdk-js";\nimport { explainAutomaticSourceToMapLibre, mountAutomaticSourceToMapLibre } from "@honua/sdk-js/map";\nimport * as maplibregl from "maplibre-gl";\nimport maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";\n\nmaplibregl.setWorkerUrl(maplibreWorkerUrl);`;

  return `${imports}\n\nconst honua = createHonua();\ntry {\n  const connection = await honua.connect({ url: ${endpoint}, protocol: ${protocol}, sourceId: ${source} });\n  try {\n    const source = connection.source(${source});\n${indent(operationBody, 4)}\n  } finally {\n    await connection.dispose();\n  }\n} finally {\n  await honua.dispose();\n}\n`;
}

function selectedSource(state: ServiceExplorerReadyState): ServiceExplorerSourceView | undefined {
  const selectedId = state.inspection.dataset.selectedSourceId;
  if (selectedId) return state.inspection.sources.find((source) => source.id === selectedId);
  return state.inspection.dataset.sourceCount === 1 ? state.inspection.sources[0] : undefined;
}

function capabilityDecision(source: ServiceExplorerSourceView, capability: "query" | "render") {
  return source.capabilityDecisions.find((decision) => decision.capability === capability);
}

function capabilityAction(
  id: ServiceExplorerOperationId,
  decision: ReturnType<typeof capabilityDecision>,
): ServiceExplorerActionDecision {
  return action(
    id,
    false,
    decision?.code ?? "capability.evidence-unavailable",
    decision?.reason ?? `No inspected ${id} capability decision is available.`,
  );
}

function projectionWithoutSource(
  query: Readonly<Query<Record<string, unknown>>>,
  code: string,
  reason: string,
  sourceId?: string,
): ServiceExplorerOperationProjection {
  return deepFreeze({
    ...(sourceId ? { sourceId } : {}),
    query,
    actions: {
      query: action("query", false, code, reason),
      render: action("render", false, code, reason),
    },
  });
}

function action(
  id: ServiceExplorerOperationId,
  enabled: boolean,
  code: string,
  reason: string,
): ServiceExplorerActionDecision {
  return Object.freeze({ id, capability: id, enabled, code, reason });
}

function validLimit(value: number): number | undefined {
  return Number.isSafeInteger(value) && value >= 1 && value <= SERVICE_EXPLORER_MAX_LIMIT ? value : undefined;
}

function errorCode(error: unknown, fallback: string): string {
  return isHonuaError(error) ? error.sdkCode : fallback;
}

function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
