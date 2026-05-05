/**
 * Framework-neutral app workspace state orchestration for sample apps.
 *
 * The workspace composes existing Honua surfaces into typed state slices.
 * Components dispatch reducer-style commands and subscribe to narrow slices or
 * selectors; no component needs an imperative reference to another component.
 *
 * @module
 */

import { isJobTerminal } from "../contract/index.js";
import type { IJobRun, JobSnapshot, SourceId } from "../contract/index.js";
import {
  EMPTY_STATE,
  featureSelectionKey,
  isSourceQualifiedSelectionTarget,
  selectLinkedViewQueryProjection,
} from "../exploration/index.js";
import type {
  ExplorationContext,
  ExplorationState,
  ExplorationStateSnapshot,
  FeatureSelectionTarget,
  FilterClause,
  LinkedViewQueryProjection,
  LinkedViewQueryProjectionOptions,
  Unsubscribe,
} from "../exploration/index.js";
import {
  type RealtimeFeatureEvent,
  type RealtimeFeatureRecord,
  type RealtimeFeatureState,
  type RealtimeFeatureTombstone,
  emptyRealtimeFeatureState,
  realtimeFeatureKey,
  reduceRealtimeFeatureState,
} from "../realtime/index.js";

export type HonuaAppWorkspaceSlice = "all" | "exploration" | "sources" | "realtime" | "jobs" | "layout" | "drafts";

export interface HonuaAppWorkspaceExplorationState {
  readonly reference?: HonuaAppWorkspaceExplorationReference;
  readonly snapshot?: ExplorationStateSnapshot;
}

export interface HonuaAppWorkspaceExplorationReference {
  readonly datasetId: string;
  readonly sourceIds: ReadonlyArray<string>;
}

export type HonuaSourceCacheStatus = "idle" | "loading" | "ready" | "stale" | "error";

export interface HonuaSourceMetadataEntry<TMetadata = unknown> {
  readonly sourceId: string;
  readonly status: HonuaSourceCacheStatus;
  readonly metadata?: TMetadata;
  readonly updatedAt?: number;
  readonly error?: unknown;
}

export interface HonuaAppWorkspaceSourceState<TMetadata = unknown> {
  readonly entries: Readonly<Record<string, HonuaSourceMetadataEntry<TMetadata>>>;
}

export interface HonuaAppWorkspaceRealtimeState<TFeature = unknown> {
  readonly features: RealtimeFeatureState<TFeature>;
}

export interface HonuaAppWorkspaceJobEntry<TResult = unknown> {
  readonly id: string;
  readonly type: string;
  readonly snapshot: JobSnapshot<TResult>;
}

export interface HonuaAppWorkspaceJobState<TResult = unknown> {
  readonly entries: Readonly<Record<string, HonuaAppWorkspaceJobEntry<TResult>>>;
}

export interface HonuaAppWorkspaceLayoutState {
  readonly activeViewId?: string;
  readonly panels: Readonly<Record<string, HonuaAppWorkspacePanelState>>;
  readonly savedState?: HonuaAppWorkspaceSavedStateMetadata;
}

export interface HonuaAppWorkspacePanelState {
  readonly visible?: boolean;
  readonly order?: number;
  readonly size?: number;
  readonly collapsed?: boolean;
}

export interface HonuaAppWorkspaceSavedStateMetadata {
  readonly id: string;
  readonly label?: string;
  readonly savedAt: number;
  readonly version?: string;
}

export interface HonuaAppWorkspaceDraftEntry<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  readonly id: string;
  readonly source: "mcp" | "ai" | "import" | "user" | (string & {});
  readonly proposedIntent: HonuaAppWorkspaceReviewableIntent<TFeature, TMetadata, TResult>;
  readonly createdAt?: number;
  readonly label?: string;
  readonly description?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonuaAppWorkspaceDraftState<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  readonly entries: Readonly<Record<string, HonuaAppWorkspaceDraftEntry<TFeature, TMetadata, TResult>>>;
  readonly activeDraftId?: string;
}

export interface HonuaAppWorkspaceState<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  readonly exploration: HonuaAppWorkspaceExplorationState;
  readonly sources: HonuaAppWorkspaceSourceState<TMetadata>;
  readonly realtime: HonuaAppWorkspaceRealtimeState<TFeature>;
  readonly jobs: HonuaAppWorkspaceJobState<TResult>;
  readonly layout: HonuaAppWorkspaceLayoutState;
  readonly drafts: HonuaAppWorkspaceDraftState<TFeature, TMetadata, TResult>;
}

export interface HonuaAppWorkspaceSnapshot<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  readonly version: 1;
  readonly state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>;
}

export interface HonuaAppWorkspaceOptions<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  readonly initialState?: Partial<HonuaAppWorkspaceState<TFeature, TMetadata, TResult>>;
}

export type HonuaAppWorkspaceReviewableIntent<TFeature = unknown, TMetadata = unknown, TResult = unknown> =
  | {
      readonly kind: "set-exploration";
      readonly reference?: HonuaAppWorkspaceExplorationReference;
      readonly snapshot?: ExplorationStateSnapshot;
    }
  | {
      readonly kind: "restore-exploration-snapshot";
      readonly snapshot: ExplorationStateSnapshot;
    }
  | {
      readonly kind: "set-source-metadata";
      readonly sourceId: string;
      readonly status: HonuaSourceCacheStatus;
      readonly metadata?: TMetadata;
      readonly updatedAt?: number;
      readonly error?: unknown;
    }
  | {
      readonly kind: "clear-source-metadata";
      readonly sourceId?: string;
    }
  | {
      readonly kind: "apply-realtime-event";
      readonly event: RealtimeFeatureEvent<TFeature>;
    }
  | {
      readonly kind: "set-realtime-state";
      readonly state: RealtimeFeatureState<TFeature>;
    }
  | {
      readonly kind: "set-job-snapshot";
      readonly jobId: string;
      readonly type: string;
      readonly snapshot: JobSnapshot<TResult>;
    }
  | {
      readonly kind: "remove-job";
      readonly jobId: string;
    }
  | {
      readonly kind: "set-layout";
      readonly layout: HonuaAppWorkspaceLayoutState;
    }
  | {
      readonly kind: "update-panel";
      readonly panelId: string;
      readonly panel: HonuaAppWorkspacePanelState;
    }
  | {
      readonly kind: "set-active-view";
      readonly viewId: string | undefined;
    }
  | {
      readonly kind: "set-saved-state-metadata";
      readonly metadata: HonuaAppWorkspaceSavedStateMetadata | undefined;
    };

export type HonuaAppWorkspaceIntent<TFeature = unknown, TMetadata = unknown, TResult = unknown> =
  | HonuaAppWorkspaceReviewableIntent<TFeature, TMetadata, TResult>
  | {
      readonly kind: "attach-exploration-context";
      readonly context: ExplorationContext;
    }
  | {
      readonly kind: "attach-job";
      readonly job: IJobRun<TResult>;
    }
  | {
      readonly kind: "stage-draft";
      readonly draft: HonuaAppWorkspaceDraftEntry<TFeature, TMetadata, TResult>;
      readonly activate?: boolean;
    }
  | {
      readonly kind: "remove-draft";
      readonly draftId: string;
    }
  | {
      readonly kind: "clear-drafts";
    }
  | {
      readonly kind: "set-active-draft";
      readonly draftId: string | undefined;
    }
  | {
      readonly kind: "restore-workspace-snapshot";
      readonly snapshot: HonuaAppWorkspaceSnapshot<TFeature, TMetadata, TResult>;
    };

export interface HonuaAppWorkspaceMapModel<TMetadata = unknown> {
  readonly extent: ExplorationState["extent"];
  readonly spatialFilter: ExplorationState["spatialFilter"];
  readonly selection: ReadonlyArray<FeatureSelectionTarget>;
  readonly sourceStatuses: Readonly<Record<SourceId, HonuaSourceCacheStatus>>;
  readonly sources: Readonly<Record<string, HonuaSourceMetadataEntry<TMetadata>>>;
  readonly query: LinkedViewQueryProjection;
}

export interface HonuaAppWorkspaceTableModel<TFeature = unknown, TMetadata = unknown> {
  readonly query: LinkedViewQueryProjection;
  readonly records: ReadonlyArray<RealtimeFeatureRecord<TFeature>>;
  readonly source?: HonuaSourceMetadataEntry<TMetadata>;
}

export interface HonuaAppWorkspaceDetailModel<TFeature = unknown> {
  readonly selection: ReadonlyArray<FeatureSelectionTarget>;
  readonly selectedRecords: ReadonlyArray<RealtimeFeatureRecord<TFeature>>;
  readonly tombstones: ReadonlyArray<RealtimeFeatureTombstone>;
  readonly missingSelection: ReadonlyArray<FeatureSelectionTarget>;
}

export interface HonuaAppWorkspaceFilterModel {
  readonly filters: Readonly<Record<string, FilterClause>>;
  readonly spatialFilter: ExplorationState["spatialFilter"];
  readonly extent: ExplorationState["extent"];
}

export interface HonuaAppWorkspaceChartModel {
  readonly query: LinkedViewQueryProjection;
  readonly grouping: ExplorationState["grouping"];
  readonly aggregation: ExplorationState["aggregation"];
}

export interface HonuaAppWorkspaceJobModel<TResult = unknown> {
  readonly entries: Readonly<Record<string, HonuaAppWorkspaceJobEntry<TResult>>>;
  readonly running: ReadonlyArray<HonuaAppWorkspaceJobEntry<TResult>>;
  readonly terminal: ReadonlyArray<HonuaAppWorkspaceJobEntry<TResult>>;
}

export interface HonuaAppWorkspaceRealtimeModel<TFeature = unknown> {
  readonly status: RealtimeFeatureState<TFeature>["status"];
  readonly cursor: RealtimeFeatureState<TFeature>["cursor"];
  readonly watermark: RealtimeFeatureState<TFeature>["watermark"];
  readonly records: ReadonlyArray<RealtimeFeatureRecord<TFeature>>;
  readonly tombstones: ReadonlyArray<RealtimeFeatureTombstone>;
  readonly ignoredEventCount: number;
}

export interface HonuaAppWorkspaceMetadataCacheModel<TMetadata = unknown> {
  readonly entries: Readonly<Record<string, HonuaSourceMetadataEntry<TMetadata>>>;
  readonly loading: ReadonlyArray<HonuaSourceMetadataEntry<TMetadata>>;
  readonly ready: ReadonlyArray<HonuaSourceMetadataEntry<TMetadata>>;
  readonly stale: ReadonlyArray<HonuaSourceMetadataEntry<TMetadata>>;
  readonly errors: ReadonlyArray<HonuaSourceMetadataEntry<TMetadata>>;
}

export interface HonuaAppWorkspaceChangeEvent<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  readonly state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>;
  readonly previous: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>;
  readonly changedSlices: ReadonlySet<HonuaAppWorkspaceSlice>;
  readonly intent: HonuaAppWorkspaceIntent<TFeature, TMetadata, TResult>;
}

export type HonuaAppWorkspaceListener<TFeature = unknown, TMetadata = unknown, TResult = unknown> = (
  event: HonuaAppWorkspaceChangeEvent<TFeature, TMetadata, TResult>,
) => void;

export type HonuaAppWorkspaceSelector<TSelected, TFeature = unknown, TMetadata = unknown, TResult = unknown> = (
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
) => TSelected;

export type HonuaAppWorkspaceSelectorListener<TSelected> = (value: TSelected, previous: TSelected) => void;

export type HonuaAppWorkspaceEquality<TSelected> = (a: TSelected, b: TSelected) => boolean;

export class HonuaAppWorkspace<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  #state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>;
  readonly #listeners = new Map<HonuaAppWorkspaceSlice, Set<HonuaAppWorkspaceListener<TFeature, TMetadata, TResult>>>();
  readonly #externalUnsubscribers = new Set<Unsubscribe>();
  #disposed = false;

  public constructor(options: HonuaAppWorkspaceOptions<TFeature, TMetadata, TResult> = {}) {
    this.#state = mergeInitialState(options.initialState);
  }

  public get state(): HonuaAppWorkspaceState<TFeature, TMetadata, TResult> {
    return this.#state;
  }

  public dispatch(intent: HonuaAppWorkspaceIntent<TFeature, TMetadata, TResult>): void {
    this.#ensureLive("dispatch");
    if (intent.kind === "attach-exploration-context") {
      this.#attachExplorationContext(intent.context);
    } else if (intent.kind === "attach-job") {
      this.#attachJob(intent.job);
    }

    const previous = this.#state;
    const next = reduceAppWorkspaceState(previous, intent);
    if (next === previous) return;
    this.#state = next;
    const changedSlices = changedWorkspaceSlices(previous, next);
    this.#emit({ state: next, previous, changedSlices, intent });
  }

  public subscribe(
    slice: HonuaAppWorkspaceSlice,
    listener: HonuaAppWorkspaceListener<TFeature, TMetadata, TResult>,
  ): Unsubscribe {
    this.#ensureLive("subscribe");
    let listeners = this.#listeners.get(slice);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(slice, listeners);
    }
    listeners.add(listener);
    return () => {
      const set = this.#listeners.get(slice);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(slice);
    };
  }

  public subscribeSelector<TSelected>(
    selector: HonuaAppWorkspaceSelector<TSelected, TFeature, TMetadata, TResult>,
    listener: HonuaAppWorkspaceSelectorListener<TSelected>,
    equality: HonuaAppWorkspaceEquality<TSelected> = Object.is,
  ): Unsubscribe {
    this.#ensureLive("subscribeSelector");
    let selected = selector(this.#state);
    return this.subscribe("all", (event) => {
      const next = selector(event.state);
      if (equality(selected, next)) return;
      const previous = selected;
      selected = next;
      listener(next, previous);
    });
  }

  public snapshot(): HonuaAppWorkspaceSnapshot<TFeature, TMetadata, TResult> {
    this.#ensureLive("snapshot");
    return { version: 1, state: cloneValue(this.#state) };
  }

  public restore(snapshot: HonuaAppWorkspaceSnapshot<TFeature, TMetadata, TResult>): void {
    this.dispatch({ kind: "restore-workspace-snapshot", snapshot });
  }

  public applyDraft(draftId: string): void {
    this.#ensureLive("applyDraft");
    const draft = this.#state.drafts.entries[draftId];
    if (!draft) throw new Error(`HonuaAppWorkspace draft ${draftId} was not found`);
    this.dispatch(draft.proposedIntent);
    this.dispatch({ kind: "remove-draft", draftId });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const unsubscribe of this.#externalUnsubscribers) unsubscribe();
    this.#externalUnsubscribers.clear();
    this.#listeners.clear();
  }

  #attachExplorationContext(context: ExplorationContext): void {
    const unsubscribe = context.subscribe("all", () => {
      if (this.#disposed) return;
      this.dispatch({
        kind: "set-exploration",
        reference: { datasetId: context.datasetId, sourceIds: context.sourceIds },
        snapshot: context.snapshot(),
      });
    });
    this.#externalUnsubscribers.add(unsubscribe);
  }

  #attachJob(job: IJobRun<TResult>): void {
    const unsubscribe = job.watch((snapshot) => {
      if (this.#disposed) return;
      this.dispatch({ kind: "set-job-snapshot", jobId: job.id, type: job.type, snapshot });
    });
    this.#externalUnsubscribers.add(unsubscribe);
  }

  #emit(event: HonuaAppWorkspaceChangeEvent<TFeature, TMetadata, TResult>): void {
    const allListeners = this.#listeners.get("all");
    if (allListeners) {
      for (const listener of [...allListeners]) listener(event);
    }
    for (const slice of event.changedSlices) {
      const listeners = this.#listeners.get(slice);
      if (!listeners) continue;
      for (const listener of [...listeners]) listener(event);
    }
  }

  #ensureLive(operation: string): void {
    if (this.#disposed) {
      throw new Error(`HonuaAppWorkspace cannot ${operation} after dispose()`);
    }
  }
}

export function createHonuaAppWorkspace<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  options?: HonuaAppWorkspaceOptions<TFeature, TMetadata, TResult>,
): HonuaAppWorkspace<TFeature, TMetadata, TResult> {
  return new HonuaAppWorkspace(options);
}

export function bindHonuaAppWorkspaceSelector<TSelected, TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  workspace: HonuaAppWorkspace<TFeature, TMetadata, TResult>,
  selector: HonuaAppWorkspaceSelector<TSelected, TFeature, TMetadata, TResult>,
  listener: HonuaAppWorkspaceSelectorListener<TSelected>,
  options: { readonly equality?: HonuaAppWorkspaceEquality<TSelected>; readonly fireImmediately?: boolean } = {},
): Unsubscribe {
  if (options.fireImmediately) {
    const selected = selector(workspace.state);
    listener(selected, selected);
  }
  return workspace.subscribeSelector(selector, listener, options.equality);
}

export function selectHonuaAppWorkspaceMapModel<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
  options: LinkedViewQueryProjectionOptions = {},
): HonuaAppWorkspaceMapModel<TMetadata> {
  const exploration = selectWorkspaceExplorationState(state);
  const sourceStatuses: Record<SourceId, HonuaSourceCacheStatus> = {};
  for (const [sourceId, entry] of Object.entries(state.sources.entries)) {
    sourceStatuses[sourceId] = entry.status;
  }
  return {
    extent: exploration.extent,
    spatialFilter: exploration.spatialFilter,
    selection: exploration.selection,
    sourceStatuses,
    sources: state.sources.entries,
    query: selectLinkedViewQueryProjection(exploration, options),
  };
}

export function selectHonuaAppWorkspaceTableModel<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
  options: LinkedViewQueryProjectionOptions = {},
): HonuaAppWorkspaceTableModel<TFeature, TMetadata> {
  return {
    query: selectLinkedViewQueryProjection(selectWorkspaceExplorationState(state), options),
    records: selectRealtimeRecords(state.realtime.features, options.sourceId),
    source: options.sourceId ? state.sources.entries[options.sourceId] : undefined,
  };
}

export function selectHonuaAppWorkspaceDetailModel<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
): HonuaAppWorkspaceDetailModel<TFeature> {
  const exploration = selectWorkspaceExplorationState(state);
  const selectedRecords: RealtimeFeatureRecord<TFeature>[] = [];
  const tombstones: RealtimeFeatureTombstone[] = [];
  const missingSelection: FeatureSelectionTarget[] = [];
  const seen = new Set<string>();

  for (const target of exploration.selection) {
    const selectionKey = featureSelectionKey(target);
    if (seen.has(selectionKey)) continue;
    seen.add(selectionKey);

    const key = realtimeKeyForSelection(target);
    const record = state.realtime.features.records[key];
    if (record) {
      selectedRecords.push(record);
      continue;
    }

    const tombstone = state.realtime.features.tombstones[key];
    if (tombstone) {
      tombstones.push(tombstone);
      continue;
    }

    missingSelection.push(target);
  }

  return {
    selection: exploration.selection,
    selectedRecords,
    tombstones,
    missingSelection,
  };
}

export function selectHonuaAppWorkspaceFilterModel<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
): HonuaAppWorkspaceFilterModel {
  const exploration = selectWorkspaceExplorationState(state);
  return {
    filters: exploration.filters,
    spatialFilter: exploration.spatialFilter,
    extent: exploration.extent,
  };
}

export function selectHonuaAppWorkspaceChartModel<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
  options: LinkedViewQueryProjectionOptions = {},
): HonuaAppWorkspaceChartModel {
  const exploration = selectWorkspaceExplorationState(state);
  return {
    query: selectLinkedViewQueryProjection(exploration, options),
    grouping: exploration.grouping,
    aggregation: exploration.aggregation,
  };
}

export function selectHonuaAppWorkspaceJobModel<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
): HonuaAppWorkspaceJobModel<TResult> {
  const entries = Object.values(state.jobs.entries);
  return {
    entries: state.jobs.entries,
    running: entries.filter((entry) => !isJobTerminal(entry.snapshot.status)),
    terminal: entries.filter((entry) => isJobTerminal(entry.snapshot.status)),
  };
}

export function selectHonuaAppWorkspaceRealtimeModel<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
  options: { readonly sourceId?: SourceId } = {},
): HonuaAppWorkspaceRealtimeModel<TFeature> {
  const realtime = state.realtime.features;
  return {
    status: realtime.status,
    cursor: realtime.cursor,
    watermark: realtime.watermark,
    records: selectRealtimeRecords(realtime, options.sourceId),
    tombstones: selectRealtimeTombstones(realtime, options.sourceId),
    ignoredEventCount: realtime.ignoredEventCount,
  };
}

export function selectHonuaAppWorkspaceMetadataCacheModel<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
): HonuaAppWorkspaceMetadataCacheModel<TMetadata> {
  const entries = Object.values(state.sources.entries);
  return {
    entries: state.sources.entries,
    loading: entries.filter((entry) => entry.status === "loading"),
    ready: entries.filter((entry) => entry.status === "ready"),
    stale: entries.filter((entry) => entry.status === "stale"),
    errors: entries.filter((entry) => entry.status === "error"),
  };
}

export function selectHonuaAppWorkspaceDrafts<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
): HonuaAppWorkspaceDraftState<TFeature, TMetadata, TResult> {
  return state.drafts;
}

function reduceAppWorkspaceState<TFeature, TMetadata, TResult>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
  intent: HonuaAppWorkspaceIntent<TFeature, TMetadata, TResult>,
): HonuaAppWorkspaceState<TFeature, TMetadata, TResult> {
  switch (intent.kind) {
    case "set-exploration":
      return withSlice(state, "exploration", {
        reference: intent.reference ? cloneValue(intent.reference) : undefined,
        snapshot: intent.snapshot ? cloneValue(intent.snapshot) : undefined,
      });
    case "attach-exploration-context":
      return withSlice(state, "exploration", {
        reference: { datasetId: intent.context.datasetId, sourceIds: [...intent.context.sourceIds] },
        snapshot: intent.context.snapshot(),
      });
    case "restore-exploration-snapshot":
      return withSlice(state, "exploration", {
        reference: state.exploration.reference,
        snapshot: cloneValue(intent.snapshot),
      });
    case "set-source-metadata":
      return withSlice(state, "sources", {
        entries: {
          ...state.sources.entries,
          [intent.sourceId]: {
            sourceId: intent.sourceId,
            status: intent.status,
            metadata: intent.metadata !== undefined ? cloneValue(intent.metadata) : undefined,
            updatedAt: intent.updatedAt,
            error: intent.error,
          },
        },
      });
    case "clear-source-metadata": {
      if (!intent.sourceId) return withSlice(state, "sources", { entries: {} });
      if (!state.sources.entries[intent.sourceId]) return state;
      const entries = { ...state.sources.entries };
      delete entries[intent.sourceId];
      return withSlice(state, "sources", { entries });
    }
    case "apply-realtime-event":
      return withSlice(state, "realtime", {
        features: reduceRealtimeFeatureState(state.realtime.features, intent.event),
      });
    case "set-realtime-state":
      return withSlice(state, "realtime", { features: cloneValue(intent.state) });
    case "set-job-snapshot":
      return withSlice(state, "jobs", {
        entries: {
          ...state.jobs.entries,
          [intent.jobId]: { id: intent.jobId, type: intent.type, snapshot: cloneValue(intent.snapshot) },
        },
      });
    case "attach-job":
      return withSlice(state, "jobs", {
        entries: {
          ...state.jobs.entries,
          [intent.job.id]: {
            id: intent.job.id,
            type: intent.job.type,
            snapshot: { status: intent.job.status, progress: intent.job.progress },
          },
        },
      });
    case "remove-job": {
      if (!state.jobs.entries[intent.jobId]) return state;
      const entries = { ...state.jobs.entries };
      delete entries[intent.jobId];
      return withSlice(state, "jobs", { entries });
    }
    case "set-layout":
      return withSlice(state, "layout", cloneValue(intent.layout));
    case "update-panel":
      return withSlice(state, "layout", {
        ...state.layout,
        panels: {
          ...state.layout.panels,
          [intent.panelId]: {
            ...state.layout.panels[intent.panelId],
            ...intent.panel,
          },
        },
      });
    case "set-active-view":
      return withSlice(state, "layout", { ...state.layout, activeViewId: intent.viewId });
    case "set-saved-state-metadata":
      return withSlice(state, "layout", { ...state.layout, savedState: intent.metadata });
    case "stage-draft":
      return withSlice(state, "drafts", {
        entries: {
          ...state.drafts.entries,
          [intent.draft.id]: cloneValue(intent.draft),
        },
        activeDraftId: intent.activate ? intent.draft.id : state.drafts.activeDraftId,
      });
    case "remove-draft": {
      if (!state.drafts.entries[intent.draftId]) return state;
      const entries = { ...state.drafts.entries };
      delete entries[intent.draftId];
      return withSlice(state, "drafts", {
        entries,
        activeDraftId: state.drafts.activeDraftId === intent.draftId ? undefined : state.drafts.activeDraftId,
      });
    }
    case "clear-drafts":
      return withSlice(state, "drafts", { entries: {} });
    case "set-active-draft":
      return withSlice(state, "drafts", { ...state.drafts, activeDraftId: intent.draftId });
    case "restore-workspace-snapshot":
      if (intent.snapshot.version !== 1) {
        throw new Error(`HonuaAppWorkspace snapshot version ${String(intent.snapshot.version)} is not supported`);
      }
      return cloneValue(intent.snapshot.state);
  }
}

function withSlice<TFeature, TMetadata, TResult, K extends Exclude<HonuaAppWorkspaceSlice, "all">>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
  slice: K,
  value: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>[K],
): HonuaAppWorkspaceState<TFeature, TMetadata, TResult> {
  if (Object.is(state[slice], value)) return state;
  return { ...state, [slice]: value };
}

function changedWorkspaceSlices<TFeature, TMetadata, TResult>(
  previous: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
  next: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
): ReadonlySet<HonuaAppWorkspaceSlice> {
  const changed = new Set<HonuaAppWorkspaceSlice>();
  if (previous.exploration !== next.exploration) changed.add("exploration");
  if (previous.sources !== next.sources) changed.add("sources");
  if (previous.realtime !== next.realtime) changed.add("realtime");
  if (previous.jobs !== next.jobs) changed.add("jobs");
  if (previous.layout !== next.layout) changed.add("layout");
  if (previous.drafts !== next.drafts) changed.add("drafts");
  return changed;
}

function mergeInitialState<TFeature, TMetadata, TResult>(
  initial: Partial<HonuaAppWorkspaceState<TFeature, TMetadata, TResult>> | undefined,
): HonuaAppWorkspaceState<TFeature, TMetadata, TResult> {
  return {
    exploration: initial?.exploration ? cloneValue(initial.exploration) : {},
    sources: initial?.sources ? cloneValue(initial.sources) : { entries: {} },
    realtime: initial?.realtime ? cloneValue(initial.realtime) : { features: emptyRealtimeFeatureState<TFeature>() },
    jobs: initial?.jobs ? cloneValue(initial.jobs) : { entries: {} },
    layout: initial?.layout ? cloneValue(initial.layout) : { panels: {} },
    drafts: initial?.drafts ? cloneValue(initial.drafts) : { entries: {} },
  };
}

function selectWorkspaceExplorationState<TFeature, TMetadata, TResult>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
): ExplorationState {
  return state.exploration.snapshot?.state ?? EMPTY_STATE;
}

function selectRealtimeRecords<TFeature>(
  state: RealtimeFeatureState<TFeature>,
  sourceId: SourceId | undefined,
): RealtimeFeatureRecord<TFeature>[] {
  return Object.values(state.records).filter((record) => sourceId === undefined || record.sourceId === sourceId);
}

function selectRealtimeTombstones<TFeature>(
  state: RealtimeFeatureState<TFeature>,
  sourceId: SourceId | undefined,
): RealtimeFeatureTombstone[] {
  return Object.values(state.tombstones).filter(
    (tombstone) => sourceId === undefined || tombstone.sourceId === sourceId,
  );
}

function realtimeKeyForSelection(target: FeatureSelectionTarget): string {
  if (isSourceQualifiedSelectionTarget(target)) return realtimeFeatureKey(target.sourceId, target.id);
  return realtimeFeatureKey(undefined, target);
}

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
