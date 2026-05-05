import { createHonuaAppWorkspace } from "@honua/sdk-js/app-workspace";
import type { HonuaAppWorkspace, HonuaSourceCacheStatus } from "@honua/sdk-js/app-workspace";
import { createExplorationContext } from "@honua/sdk-js/exploration";
import type { ExplorationContext, ExplorationViewController } from "@honua/sdk-js/exploration";
import {
  bindChartToExploration,
  bindFilterControlsToExploration,
  bindTableSelectionToExploration,
} from "@honua/sdk-js/interactions";
import type {
  ChartExplorationBinding,
  FilterControlsExplorationBinding,
  TableSelectionExplorationBinding,
} from "@honua/sdk-js/interactions";

import { createServiceExplorerQueryDiagnostics } from "./projection.js";
import type {
  ServiceExplorerDataset,
  ServiceExplorerFeatureSummary,
  ServiceExplorerProjectionResult,
  ServiceExplorerQueryDiagnostics,
  ServiceExplorerSourceMetadata,
} from "./types.js";

export type ServiceExplorerJobOutput = ServiceExplorerProjectionResult | ServiceExplorerQueryDiagnostics;
export type ServiceExplorerAppWorkspace = HonuaAppWorkspace<
  ServiceExplorerFeatureSummary,
  ServiceExplorerSourceMetadata,
  ServiceExplorerJobOutput
>;

export interface ServiceExplorerWorkspaceViews {
  readonly map: ExplorationViewController;
  readonly table: ExplorationViewController;
  readonly chart: ExplorationViewController;
  readonly filters: ExplorationViewController;
  readonly detail: ExplorationViewController;
}

export interface ServiceExplorerWorkspaceControllers {
  readonly filters: FilterControlsExplorationBinding;
  readonly table: TableSelectionExplorationBinding;
  readonly chart: ChartExplorationBinding;
}

export interface ServiceExplorerWorkspace {
  readonly workspace: ServiceExplorerAppWorkspace;
  readonly exploration: ExplorationContext;
  readonly views: ServiceExplorerWorkspaceViews;
  readonly controllers: ServiceExplorerWorkspaceControllers;
  readonly sourceId: string;
  dispose(): void;
}

export function createServiceExplorerWorkspace(
  dataset: ServiceExplorerDataset,
  options: { readonly now?: number } = {},
): ServiceExplorerWorkspace {
  const workspace = createHonuaAppWorkspace<
    ServiceExplorerFeatureSummary,
    ServiceExplorerSourceMetadata,
    ServiceExplorerJobOutput
  >();
  const exploration = createExplorationContext({
    datasetId: `${dataset.metadata.service.id}/${dataset.metadata.layer.id}`,
    sourceIds: [dataset.sourceId],
    preset: "globalLinked",
  });
  const views = {
    map: exploration.connectView({ id: "service-explorer-map", role: "map" }),
    table: exploration.connectView({ id: "service-explorer-table", role: "grid" }),
    chart: exploration.connectView({ id: "service-explorer-chart", role: "chart" }),
    filters: exploration.connectView({ id: "service-explorer-filters", role: "filter" }),
    detail: exploration.connectView({ id: "service-explorer-detail", role: "detail" }),
  };

  workspace.dispatch({ kind: "attach-exploration-context", context: exploration });
  workspace.dispatch({
    kind: "set-layout",
    layout: {
      activeViewId: "service-explorer-map",
      panels: {
        discovery: { visible: true, order: 1, size: 280 },
        metadata: { visible: true, order: 2, size: 320 },
        details: { visible: true, order: 3, size: 340 },
        diagnostics: { visible: true, order: 4, size: 280 },
      },
    },
  });

  seedExplorationDefaults(exploration, dataset);
  syncExplorationSnapshot(workspace, exploration);
  seedServiceExplorerWorkspace(workspace, dataset, options);

  return {
    workspace,
    exploration,
    views,
    controllers: {
      filters: bindFilterControlsToExploration(views.filters),
      table: bindTableSelectionToExploration(views.table),
      chart: bindChartToExploration(views.chart),
    },
    sourceId: dataset.sourceId,
    dispose(): void {
      workspace.dispose();
      exploration.dispose();
    },
  };
}

export function seedServiceExplorerWorkspace(
  workspace: ServiceExplorerAppWorkspace,
  dataset: ServiceExplorerDataset,
  options: { readonly now?: number } = {},
): void {
  const now = options.now ?? Date.now();
  workspace.dispatch({
    kind: "set-source-metadata",
    sourceId: dataset.sourceId,
    status: dataset.metadata.cache.status,
    metadata: withCacheStatus(dataset.metadata, dataset.metadata.cache.status, now),
    updatedAt: now,
  });
  workspace.dispatch({
    kind: "apply-realtime-event",
    event: {
      type: "snapshot",
      receivedAt: now,
      cursor: `${dataset.source}:${dataset.sourceId}:${now}`,
      watermark: new Date(now).toISOString(),
      features: dataset.featureSummaries.map((summary) => ({
        sourceId: dataset.sourceId,
        id: summary.id,
        feature: summary,
      })),
    },
  });
}

export function beginServiceExplorerMetadataRevalidation(
  workspace: ServiceExplorerAppWorkspace,
  dataset: ServiceExplorerDataset,
  options: { readonly now?: number } = {},
): void {
  const now = options.now ?? Date.now();
  workspace.dispatch({
    kind: "set-source-metadata",
    sourceId: dataset.sourceId,
    status: "loading",
    metadata: withCacheStatus(dataset.metadata, "loading", now),
    updatedAt: now,
  });
}

export function completeServiceExplorerMetadataRevalidation(
  workspace: ServiceExplorerAppWorkspace,
  dataset: ServiceExplorerDataset,
  options: { readonly now?: number; readonly status?: HonuaSourceCacheStatus; readonly error?: unknown } = {},
): void {
  const now = options.now ?? Date.now();
  const status = options.status ?? "ready";
  workspace.dispatch({
    kind: "set-source-metadata",
    sourceId: dataset.sourceId,
    status,
    metadata: withCacheStatus(dataset.metadata, status, now),
    updatedAt: now,
    error: options.error,
  });
}

export function recordServiceExplorerQueryProjection(
  workspace: ServiceExplorerAppWorkspace,
  result: ServiceExplorerProjectionResult,
): void {
  const diagnostics = createServiceExplorerQueryDiagnostics(result.projection);
  workspace.dispatch({
    kind: "set-job-snapshot",
    jobId: "linked-query-projection",
    type: "linked-query",
    snapshot: {
      status: "successful",
      result: {
        outputs: {
          projection: result,
          diagnostics,
        },
      },
    },
  });
}

function seedExplorationDefaults(exploration: ExplorationContext, dataset: ServiceExplorerDataset): void {
  const visibleFields = ["OBJECTID", "title", "status", "category", "priority", "district"].filter((field) =>
    dataset.metadata.schema.fields?.some((entry) => entry.name === field),
  );
  exploration.dispatch({ kind: "set-visible-fields", fields: visibleFields });
  exploration.dispatch({ kind: "set-page", page: { offset: 0, limit: 25 } });
  exploration.dispatch({ kind: "set-sort", sort: [{ field: "priority", direction: "asc" }] });
  exploration.dispatch({ kind: "set-grouping", grouping: ["status"] });
  exploration.dispatch({
    kind: "set-aggregation",
    aggregation: {
      groupBy: ["status"],
      metrics: [{ fn: "count", field: "OBJECTID", alias: "features" }],
    },
  });
}

function syncExplorationSnapshot(workspace: ServiceExplorerAppWorkspace, exploration: ExplorationContext): void {
  workspace.dispatch({
    kind: "set-exploration",
    reference: { datasetId: exploration.datasetId, sourceIds: exploration.sourceIds },
    snapshot: exploration.snapshot(),
  });
}

function withCacheStatus(
  metadata: ServiceExplorerSourceMetadata,
  status: HonuaSourceCacheStatus,
  now: number,
): ServiceExplorerSourceMetadata {
  return {
    ...metadata,
    cache: {
      ...metadata.cache,
      status,
      updatedAt: now,
      lastRevalidatedAt: status === "ready" ? now : metadata.cache.lastRevalidatedAt,
    },
  };
}
