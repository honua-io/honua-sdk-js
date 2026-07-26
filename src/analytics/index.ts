/**
 * `@honua/sdk-js/analytics` — the versioned linked-analytics and chart
 * presentation contract.
 *
 * Honua does not ship a chart suite. This entrypoint is the seam that lets a
 * server-pushdown widget model, a bounded columnar reduction, a small
 * accessible default presentation, and any specialist chart library share one
 * filter / selection / temporal / capability / provenance model.
 *
 * The barrel intentionally exports **no chart adapters**. Third-party adapters
 * live behind their own subpath (`@honua/sdk-js/analytics/uplot`) and load their
 * peer through a dynamic import, so an app that never charts pays nothing —
 * which the `/analytics` bundle guard asserts structurally.
 *
 * @example
 * ```ts
 * import { createWidgetSource } from "@honua/sdk-js/contract";
 * import {
 *   acceptWidgetTimeSeriesArtifact,
 *   createAnalyticsAdapterRegistry,
 *   createAnalyticsLinkedSession,
 *   createDefaultAnalyticsPresentation,
 * } from "@honua/sdk-js/analytics";
 *
 * const widgets = createWidgetSource(source);
 * const response = await widgets.timeSeries({ field: "reported_at", interval: { unit: "day" } });
 * const artifact = acceptWidgetTimeSeriesArtifact(response, { artifactId: "incidents-by-day" });
 *
 * const registry = createAnalyticsAdapterRegistry({
 *   adapters: [createDefaultAnalyticsPresentation()],
 * });
 * const session = createAnalyticsLinkedSession({ view, artifact, registry });
 * await session.present({ target: panel });
 * ```
 *
 * @experimental Not yet covered by the SDK's semver contract — these shapes
 *   may change in any minor release prior to `1.0.0`.
 * @packageDocumentation
 */

export { ANALYTICS_CONTRACT_VERSION, EMPTY_ANALYTICS_LINKED_STATE, HonuaAnalyticsError } from "./types.js";
export type {
  AnalyticsAggregateArtifact,
  AnalyticsAggregateMark,
  AnalyticsArtifact,
  AnalyticsArtifactIdentity,
  AnalyticsArtifactKind,
  AnalyticsArtifactStatus,
  AnalyticsBounds,
  AnalyticsCategoryArtifact,
  AnalyticsCategoryMark,
  AnalyticsClearInteraction,
  AnalyticsComputeSite,
  AnalyticsContractVersion,
  AnalyticsDegradation,
  AnalyticsFilterClauseIds,
  AnalyticsFilterContribution,
  AnalyticsFreshness,
  AnalyticsFreshnessState,
  AnalyticsHistogramArtifact,
  AnalyticsHistogramMark,
  AnalyticsHoverInteraction,
  AnalyticsInteraction,
  AnalyticsInteractionChannel,
  AnalyticsLinkBindingOptions,
  AnalyticsLinkCommit,
  AnalyticsLinkedState,
  AnalyticsLinkedStateBinding,
  AnalyticsMark,
  AnalyticsMarkBase,
  AnalyticsMarkSelectInteraction,
  AnalyticsMeasure,
  AnalyticsMountRequest,
  AnalyticsNullPolicy,
  AnalyticsNumericRange,
  AnalyticsOrdering,
  AnalyticsOrderingKey,
  AnalyticsPresentationAdapter,
  AnalyticsPresentationHandle,
  AnalyticsPresentationHost,
  AnalyticsProvenance,
  AnalyticsRangeBrushInteraction,
  AnalyticsSupportDecision,
  AnalyticsTemporalBrushInteraction,
  AnalyticsTemporalWindow,
  AnalyticsTimeSeriesArtifact,
  AnalyticsTimeSeriesMark,
  AnalyticsUnsupportedReason,
  AnalyticsUpdateDecision,
  AnalyticsUpdateDisposition,
  HonuaAnalyticsErrorCode,
} from "./types.js";

export {
  acceptAggregateArtifact,
  acceptCategoryArtifact,
  acceptHistogramArtifact,
  acceptTimeSeriesArtifact,
  analyticsArtifactIdentity,
  analyticsMarkByKey,
  analyticsProvenance,
  assertAnalyticsContractVersion,
  DEFAULT_BUCKET_ORDERING,
  DEFAULT_CATEGORY_ORDERING,
  DEFAULT_TIME_ORDERING,
  MAX_ANALYTICS_MARKS,
  resolveAnalyticsStatus,
  resolveAnalyticsUpdateDisposition,
  temporalWindowForMarks,
  UNBOUNDED,
  unsupportedAnalyticsArtifact,
  validateAnalyticsArtifact,
} from "./artifact.js";
export type { AcceptAnalyticsOptions, AnalyticsIdentityInput, AnalyticsProvenanceInput } from "./artifact.js";

export {
  acceptWidgetAggregateArtifact,
  acceptWidgetCategoriesArtifact,
  acceptWidgetHistogramArtifact,
  acceptWidgetTimeSeriesArtifact,
  assertAnalyticsPushdown,
  categoryMarkKey,
  widgetResponseProvenance,
} from "./widget-source-bridge.js";
export type { AcceptWidgetArtifactOptions } from "./widget-source-bridge.js";

export {
  analyticsClauseIds,
  analyticsFilterContributions,
  analyticsMarkFilterClause,
  analyticsRangeFilterClause,
  analyticsTemporalFilterClause,
  bindAnalyticsToExploration,
  selectAnalyticsLinkedState,
} from "./linked-state.js";

export {
  ANALYTICS_NULL_RENDERING,
  analyticsTableModel,
  analyticsTableModelOf,
  createAccessibleTableAdapter,
} from "./accessible-table.js";
export type { AnalyticsTableModel, AnalyticsTableRow } from "./accessible-table.js";

export {
  analyticsBrushIndices,
  createDefaultAnalyticsPresentation,
  renderAnalyticsBrushHtml,
  renderAnalyticsTableHtml,
} from "./default-presentation.js";
export type { DefaultAnalyticsPresentationOptions } from "./default-presentation.js";

export { createDisposableHandle } from "./handle.js";
export type { DisposableHandleSpec } from "./handle.js";

export { createAnalyticsAdapterRegistry } from "./registry.js";
export type {
  AnalyticsAdapterRegistry,
  AnalyticsPresentationResolution,
  CreateAnalyticsAdapterRegistryOptions,
  ResolveAnalyticsPresentationOptions,
} from "./registry.js";

export { createAnalyticsLinkedSession } from "./session.js";
export type {
  AnalyticsLinkedSession,
  AnalyticsPresentOptions,
  AnalyticsSessionPresentation,
  CreateAnalyticsLinkedSessionOptions,
} from "./session.js";
