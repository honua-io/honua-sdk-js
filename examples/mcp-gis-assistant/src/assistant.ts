import { createHonuaAppWorkspace } from "@honua/sdk-js/app-workspace";
import type { HonuaAppWorkspace, HonuaAppWorkspaceDraftEntry } from "@honua/sdk-js/app-workspace";
import { createExplorationContext, selectLinkedViewQueryProjection } from "@honua/sdk-js/exploration";
import type { ExplorationContext, FilterClause, LinkedViewQueryProjection } from "@honua/sdk-js/exploration";

import { ASSISTANT_RESULT_LIMIT, createFixtureMcpGisAssistantDataset } from "./fixtures.js";
import type {
  AssistantBoundedSummary,
  AssistantDataset,
  AssistantDraftQuery,
  AssistantFeature,
  AssistantSourceMetadata,
  AssistantToolCall,
  AssistantTurn,
} from "./types.js";

export interface McpGisAssistantSession {
  readonly dataset: AssistantDataset;
  readonly workspace: HonuaAppWorkspace<AssistantFeature, AssistantSourceMetadata, AssistantTurn>;
  readonly exploration: ExplorationContext;
  readonly turns: readonly AssistantTurn[];
  ask(userText: string): AssistantTurn;
  applyDraft(draftId: string): LinkedViewQueryProjection | undefined;
  currentProjection(): LinkedViewQueryProjection;
  dispose(): void;
}

export function createMcpGisAssistantSession(dataset = createFixtureMcpGisAssistantDataset()): McpGisAssistantSession {
  const workspace = createHonuaAppWorkspace<AssistantFeature, AssistantSourceMetadata, AssistantTurn>();
  const exploration = createExplorationContext({
    datasetId: dataset.workspaceId,
    sourceIds: [dataset.activeSourceId],
    preset: "globalLinked",
  });
  const turns: AssistantTurn[] = [];

  workspace.dispatch({ kind: "attach-exploration-context", context: exploration });
  workspace.dispatch({
    kind: "set-source-metadata",
    sourceId: dataset.activeSourceId,
    status: dataset.metadata.cache.status,
    metadata: dataset.metadata,
    updatedAt: dataset.metadata.cache.updatedAt,
  });
  workspace.dispatch({
    kind: "apply-realtime-event",
    event: {
      type: "snapshot",
      receivedAt: dataset.metadata.cache.updatedAt,
      cursor: `fixture:${dataset.activeSourceId}`,
      features: dataset.features.map((feature) => ({ sourceId: dataset.activeSourceId, id: feature.id, feature })),
    },
  });
  exploration.dispatch({ kind: "set-visible-fields", fields: ["OBJECTID", "title", "status", "priority"] });
  exploration.dispatch({ kind: "set-page", page: { offset: 0, limit: ASSISTANT_RESULT_LIMIT } });
  syncExploration(workspace, exploration);

  return {
    dataset,
    workspace,
    exploration,
    get turns() {
      return turns;
    },
    ask(userText: string): AssistantTurn {
      const turn = answerWithFixtures(dataset, userText, turns.length + 1);
      turns.push(turn);
      workspace.dispatch({
        kind: "set-job-snapshot",
        jobId: `assistant-turn-${turn.id}`,
        type: "mcp-assistant-turn",
        snapshot: { status: "successful", result: { outputs: { turn } } },
      });
      if (turn.draft) {
        workspace.dispatch({ kind: "stage-draft", activate: true, draft: draftFromQuery(turn.draft) });
      }
      return turn;
    },
    applyDraft(draftId: string): LinkedViewQueryProjection | undefined {
      const draft = workspace.state.drafts.entries[draftId];
      workspace.applyDraft(draftId);
      if (draft?.proposedIntent.kind === "restore-exploration-snapshot") {
        exploration.restore(draft.proposedIntent.snapshot);
        syncExploration(workspace, exploration);
        return selectLinkedViewQueryProjection(exploration.state, { sourceId: dataset.activeSourceId });
      }
      return undefined;
    },
    currentProjection(): LinkedViewQueryProjection {
      return selectLinkedViewQueryProjection(exploration.state, { sourceId: dataset.activeSourceId });
    },
    dispose(): void {
      workspace.dispose();
      exploration.dispose();
    },
  };
}

export function answerWithFixtures(dataset: AssistantDataset, userText: string, index: number): AssistantTurn {
  const normalized = userText.toLowerCase();
  const toolCalls: AssistantToolCall[] = [];
  const startedAt = 1_798_742_400_000 + index;

  if (normalized.includes("credential") || normalized.includes("connect")) {
    return turn(index, userText, {
      assistantText:
        "This fixture is safe without credentials. A live Honua Cloud MCP session needs HONUA_API_KEY or HONUA_BEARER_TOKEN before tool calls are enabled.",
      toolCalls: [
        toolCall(startedAt, "list_services", { workspaceId: dataset.workspaceId }, { services: dataset.services }),
      ],
      diagnostics: dataset.diagnostics,
    });
  }

  if (normalized.includes("service") || normalized.includes("layer") || normalized.includes("schema")) {
    toolCalls.push(toolCall(startedAt, "list_services", {}, { services: dataset.services }));
    toolCalls.push(
      toolCall(
        startedAt + 3,
        "describe_layer",
        { serviceId: dataset.metadata.service.id, layerId: dataset.metadata.layer.id },
        { layer: dataset.metadata.layer, fields: dataset.metadata.fields, capabilities: dataset.metadata.capabilities },
      ),
    );
    return turn(index, userText, {
      assistantText: `Grounded in ${dataset.metadata.service.name}: ${dataset.layers.length} layer(s) are visible. ${dataset.metadata.layer.name} exposes ${dataset.metadata.fields.length} fields and ${dataset.metadata.layer.featureCount} features.`,
      toolCalls,
      diagnostics: dataset.diagnostics,
    });
  }

  if (normalized.includes("unsupported") || normalized.includes("realtime") || normalized.includes("statistics")) {
    return turn(index, userText, {
      assistantText:
        "The assistant can list services, describe layers, and query bounded features. Realtime is unsupported in this fixture and statistics are degraded to client-side counts.",
      toolCalls: [
        toolCall(startedAt, "describe_layer", { serviceId: dataset.metadata.service.id, layerId: 0 }, dataset.metadata),
      ],
      diagnostics: dataset.diagnostics,
    });
  }

  const filter = filterFromPrompt(normalized);
  const matched = applyFilters(dataset.features, filter.filters);
  const summary = boundedSummary(matched, ASSISTANT_RESULT_LIMIT);
  const draft = createDraftQuery(filter.label, filter.where, filter.filters, matched.length);
  toolCalls.push(
    toolCall(
      startedAt,
      "query_features",
      {
        serviceId: dataset.metadata.service.id,
        layerId: dataset.metadata.layer.id,
        where: filter.where,
        resultRecordCount: ASSISTANT_RESULT_LIMIT,
        returnGeometry: true,
      },
      summary,
    ),
  );

  return turn(index, userText, {
    assistantText: `I found ${summary.totalMatched} matching feature(s) and returned ${summary.returned}. Review the proposed filter before applying it to the map and table.`,
    toolCalls,
    summary,
    draft,
    diagnostics: dataset.diagnostics,
  });
}

function filterFromPrompt(normalized: string): { label: string; where: string; filters: Record<string, FilterClause> } {
  if (normalized.includes("critical")) {
    return {
      label: "Open critical tasks",
      where: "status = 'open' AND priority = 'critical'",
      filters: {
        status: { field: "status", operator: "=", value: "open" },
        priority: { field: "priority", operator: "=", value: "critical" },
      },
    };
  }
  if (normalized.includes("open")) {
    return {
      label: "Open tasks",
      where: "status = 'open'",
      filters: { status: { field: "status", operator: "=", value: "open" } },
    };
  }
  return {
    label: "Urban tasks",
    where: "district = 'urban'",
    filters: { district: { field: "district", operator: "=", value: "urban" } },
  };
}

function createDraftQuery(
  label: string,
  where: string,
  filters: Readonly<Record<string, FilterClause>>,
  estimatedCount: number,
): AssistantDraftQuery {
  const projection: LinkedViewQueryProjection = {
    filters,
    orderBy: [],
    pagination: { offset: 0, limit: ASSISTANT_RESULT_LIMIT },
    outFields: ["OBJECTID", "title", "status", "priority"],
    grouping: [],
    selection: [],
  };
  return { id: "draft-generated-filter", label, where, filters, projection, estimatedCount };
}

function draftFromQuery(
  draft: AssistantDraftQuery,
): HonuaAppWorkspaceDraftEntry<AssistantFeature, AssistantSourceMetadata, AssistantTurn> {
  return {
    id: draft.id,
    source: "mcp",
    label: draft.label,
    description: draft.where,
    proposedIntent: {
      kind: "restore-exploration-snapshot",
      snapshot: {
        version: 1,
        state: {
          preset: "globalLinked",
          filters: draft.filters,
          sort: draft.projection.orderBy,
          page: draft.projection.pagination,
          visibleFields: draft.projection.outFields ?? [],
          grouping: draft.projection.grouping,
          selection: [],
        },
      },
    },
    metadata: { where: draft.where, estimatedCount: draft.estimatedCount },
  };
}

export function applyFilters(
  features: readonly AssistantFeature[],
  filters: Readonly<Record<string, FilterClause>>,
): AssistantFeature[] {
  return features.filter((feature) =>
    Object.values(filters).every((filter) => feature.attributes[filter.field] === filter.value),
  );
}

export function boundedSummary(features: readonly AssistantFeature[], limit: number): AssistantBoundedSummary {
  return {
    totalMatched: features.length,
    returned: Math.min(features.length, limit),
    limit,
    truncated: features.length > limit,
    rows: features.slice(0, limit),
  };
}

function syncExploration(
  workspace: HonuaAppWorkspace<AssistantFeature, AssistantSourceMetadata, AssistantTurn>,
  exploration: ExplorationContext,
): void {
  workspace.dispatch({
    kind: "set-exploration",
    reference: { datasetId: exploration.datasetId, sourceIds: exploration.sourceIds },
    snapshot: exploration.snapshot(),
  });
}

function toolCall(
  startedAt: number,
  name: AssistantToolCall["name"],
  args: Readonly<Record<string, unknown>>,
  result: unknown,
): AssistantToolCall {
  return { id: `${name}-${startedAt}`, name, arguments: args, result, startedAt, durationMs: 2, status: "ok" };
}

function turn(index: number, userText: string, input: Omit<AssistantTurn, "id" | "userText">): AssistantTurn {
  return { id: String(index).padStart(2, "0"), userText, ...input };
}
